/**
 * AI generation pipeline against real D1, with a STUB provider.
 *
 * No network, no API key: the pipeline takes its provider as an argument, which
 * is exactly why it is testable at all. What is verified here is the REVAMPED
 * contract:
 *
 *   1. "Ask for N, get N" — a short round is topped up by the next round.
 *   2. Duplicates are AUTO-FILTERED against the whole bank (never stored).
 *   3. The request budget comes from the count and the model's real output
 *      ceiling — not a hard-coded 8000 tokens.
 *   4. Generating NEVER writes to `questions`; only the explicit commit does.
 *   5. Committing inserts ACTIVE questions and attaches them to the Q Set, so
 *      they are playable as soon as the set is published.
 */

import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { getPlatformProxy } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, setDbForTests } from "@/db/client";
import * as schema from "@/db/schema";
import {
  commitJobToSet,
  createGenerationJob,
  getJob,
  listCandidates,
  listJobCandidates,
  outputBudgetFor,
  promptVersionStats,
  runGenerationStep,
  setCandidateRejected,
  stubProvider,
  LlmError,
  type GenerationDeps,
  type RawStorage,
} from "@/modules/ai";
import { createCategory, createSet } from "@/modules/catalog";

const ACTOR = "user__ai_test";
const TOPIC = "AiPipelineTest";

let proxy: { env: { DB: D1Database }; dispose: () => Promise<void> } | null = null;

const BACKSTORY =
  "A sufficiently long backstory for the AI pipeline tests, written as prose so the schema's " +
  "minimum length is satisfied and the review screen has something real to render.";

const question = (stem: string, overrides: Record<string, unknown> = {}) => ({
  stem,
  options: [
    { key: "A", body: "Zephyr" },
    { key: "B", body: "Quartz" },
    { key: "C", body: "Nimbus" },
    { key: "D", body: "Onyx" },
  ],
  correct_option_key: "A",
  explanation: "Because Zephyr is correct.",
  backstory: BACKSTORY,
  difficulty: "easy",
  topic: TOPIC,
  tags: ["ai-test"],
  ...overrides,
});

/** In-memory stand-in for R2, so the tests need no binding. */
function memoryStorage(): RawStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    async put(key, value) {
      map.set(key, value);
    },
    async get(key) {
      return map.get(key) ?? null;
    },
  };
}

function deps(text: string | ((request: { maxTokens?: number }) => string)): GenerationDeps & {
  storage: ReturnType<typeof memoryStorage>;
} {
  return {
    provider: stubProvider((request) =>
      typeof text === "function" ? text(request) : text,
    ),
    storage: memoryStorage(),
  };
}

const envelope = (...questions: unknown[]) => JSON.stringify({ questions });

async function countQuestions(): Promise<number> {
  const row = (await db().select({ n: sql<number>`count(*)` }).from(schema.questions))[0];
  return Number(row?.n ?? 0);
}

beforeAll(async () => {
  proxy = await getPlatformProxy<{ DB: D1Database }>({
    configPath: "wrangler.jsonc",
    persist: { path: ".tooling/test-state" },
  });
  setDbForTests(drizzle(proxy.env.DB, { schema }));
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await proxy?.dispose();
  proxy = null;
  setDbForTests(null);
});

async function cleanup(): Promise<void> {
  const jobs = await db().select({ id: schema.aiGenerationJobs.id }).from(schema.aiGenerationJobs);
  for (const job of jobs) {
    await db().delete(schema.aiCandidates).where(eq(schema.aiCandidates.jobId, job.id)).run();
    await db().delete(schema.aiGenerationJobs).where(eq(schema.aiGenerationJobs.id, job.id)).run();
  }
  await db().delete(schema.questions).where(eq(schema.questions.topic, TOPIC)).run();
}

async function newJob(count = 3, model = "stub/model") {
  return createGenerationJob(
    { topic: TOPIC, brief: "Write test questions.", requestedCount: count, model },
    ACTOR,
  );
}

// ── §2.2 — the hard rule ─────────────────────────────────────────────────────

describe("§2.2 AI output is never published content on its own", () => {
  it("NEVER writes to the questions table, however the job ends", async () => {
    const before = await countQuestions();

    const job = await newJob(2);
    const d = deps(
      envelope(
        question("Ai pipeline never publishes question one?"),
        question("Ai pipeline never publishes question two?"),
      ),
    );

    const progress = await runGenerationStep(job.id, d);
    expect(progress.done).toBe(true);
    expect(progress.producedCount).toBe(2);

    const after = await countQuestions();
    expect(after).toBe(before);

    // The questions landed in the working set instead.
    const candidates = await listJobCandidates(job.id);
    expect(candidates).toHaveLength(2);
    expect(candidates.every((c) => c.rejected === 0)).toBe(true);
  });
});

// ── the budget ───────────────────────────────────────────────────────────────

describe("output budget follows the count and the model", () => {
  it("asks for far more than the old 8000-token ceiling on a large-output model", async () => {
    const asked: Array<number | undefined> = [];
    const job = await newJob(10, "deepseek/deepseek-v4.1-flash");

    const d: GenerationDeps = {
      provider: stubProvider((request) => {
        asked.push(request.maxTokens);
        return envelope(question("Budget probe question one?"));
      }),
      storage: memoryStorage(),
    };

    await runGenerationStep(job.id, d);

    expect(asked).toHaveLength(1);
    expect(asked[0]).toBe(outputBudgetFor(10, "deepseek/deepseek-v4.1-flash"));
    // 10 questions x ~850 tokens + headroom, well above the old hard-coded 8000.
    expect(asked[0]!).toBeGreaterThan(9_000);
  });

  it("clamps to a small model's real ceiling and lets backfill finish the job", async () => {
    // Llama 3.3 caps at 4k, so one call cannot hold 10 questions — the rounds
    // must keep asking until the count is met.
    expect(outputBudgetFor(50, "meta-llama/llama-3.3-70b-instruct")).toBe(4_000);
  });
});

// ── ask for N, get N ─────────────────────────────────────────────────────────

describe("generate-to-N", () => {
  it("delivers the exact count in one round when the model complies", async () => {
    const job = await newJob(3);
    const d = deps(
      envelope(
        question("Exact count alpha question?"),
        question("Exact count bravo question?"),
        question("Exact count charlie question?"),
      ),
    );

    const progress = await runGenerationStep(job.id, d);
    expect(progress.done).toBe(true);
    expect(progress.status).toBe("succeeded");
    expect(progress.producedCount).toBe(3);
    expect(progress.duplicateCount).toBe(0);
    expect(progress.round).toBe(1);
  });

  it("TOPS UP a short round until the requested count is reached", async () => {
    const job = await newJob(3);
    const rounds: string[] = [
      envelope(question("Backfill alpha question?")),
      envelope(question("Backfill bravo question?"), question("Backfill charlie question?")),
    ];

    const d: GenerationDeps & { storage: ReturnType<typeof memoryStorage> } = {
      provider: stubProvider(() => rounds.shift() ?? envelope()),
      storage: memoryStorage(),
    };

    const first = await runGenerationStep(job.id, d);
    expect(first.done).toBe(false);
    expect(first.status).toBe("running");
    expect(first.producedCount).toBe(1);

    const second = await runGenerationStep(job.id, d);
    expect(second.done).toBe(true);
    expect(second.status).toBe("succeeded");
    expect(second.producedCount).toBe(3);
    expect(second.round).toBe(2);
  });

  it("still delivers N rows when the topic is already covered — as rejected duplicates", async () => {
    const job = await newJob(2);
    const { createQuestion } = await import("@/modules/questions");
    await createQuestion(
      {
        stem: "Saturated topic question?",
        options: [
          { key: "A", body: "Zephyr" },
          { key: "B", body: "Quartz" },
          { key: "C", body: "Nimbus" },
          { key: "D", body: "Onyx" },
        ],
        correctOptionKey: "A",
        explanation: "Existing.",
        backstory: BACKSTORY,
        difficulty: "easy",
        topic: TOPIC,
        tags: [],
      },
      ACTOR,
      { status: "active" },
    );

    // Both requested rows come back as questions — nothing is silently dropped.
    const d = deps(
      envelope(question("Saturated topic question?"), question("Saturated topic question?")),
    );

    const progress = await runGenerationStep(job.id, d);
    expect(progress.done).toBe(true);
    expect(progress.status).toBe("succeeded");
    expect(progress.producedCount).toBe(2);
    expect(progress.duplicateCount).toBe(2);

    const stored = await listJobCandidates(job.id);
    expect(stored).toHaveLength(2);
    // Every one of them is present, rejected by default, with the match shown.
    expect(stored.every((c) => c.rejected === 1)).toBe(true);
  });
});

// ── duplicate filtration ─────────────────────────────────────────────────────

describe("duplicates are shown, rejected by default, and overridable", () => {
  async function seedBankQuestion(stem: string) {
    const { createQuestion } = await import("@/modules/questions");
    return createQuestion(
      {
        stem,
        options: [
          { key: "A", body: "Zephyr" },
          { key: "B", body: "Quartz" },
          { key: "C", body: "Nimbus" },
          { key: "D", body: "Onyx" },
        ],
        correctOptionKey: "A",
        explanation: "Existing.",
        backstory: BACKSTORY,
        difficulty: "easy",
        topic: TOPIC,
        tags: [],
      },
      ACTOR,
      { status: "active" },
    );
  }

  it("keeps an exact duplicate, marks it rejected, and names the existing question", async () => {
    const existing = await seedBankQuestion("Which metal has the symbol Au in the AI pipeline?");

    const job = await newJob(2);
    const d = deps(
      envelope(
        // Identical after normalization → layer 1 exact duplicate.
        question("WHICH METAL HAS THE SYMBOL AU IN THE AI PIPELINE"),
        question("A genuinely fresh AI pipeline question?"),
      ),
    );

    const progress = await runGenerationStep(job.id, d);

    // Both are stored — the duplicate is NOT hidden.
    expect(progress.producedCount).toBe(2);
    expect(progress.duplicateCount).toBe(1);

    const stored = await listJobCandidates(job.id);
    expect(stored).toHaveLength(2);

    const flagged = stored.find((c) => c.dedupeStatus === "exact_dup")!;
    expect(flagged).toBeTruthy();
    expect(flagged.rejected).toBe(1);
    expect(flagged.dedupeMatchedQuestionId).toBe(existing.question.id);
    expect(flagged.dedupeMatchedStem).toBe(existing.question.stem);
    expect(flagged.dedupeReason).toMatch(/already in the bank/i);

    const clean = stored.find((c) => c.dedupeStatus === "clean")!;
    expect(clean.rejected).toBe(0);
    expect(clean.dedupeMatchedStem).toBeNull();
  });

  it("detects a question already saved in a Q Set (the whole bank is the reference)", async () => {
    const { createQuestion } = await import("@/modules/questions");
    const { createCategory, createSet } = await import("@/modules/catalog");
    const { attachQuestions } = await import("@/modules/questions");

    const { question: existing } = await createQuestion(
      {
        stem: "Which company did Satya Nadella lead as CEO?",
        options: [
          { key: "A", body: "Zephyr" },
          { key: "B", body: "Quartz" },
          { key: "C", body: "Nimbus" },
          { key: "D", body: "Onyx" },
        ],
        correctOptionKey: "A",
        explanation: "Existing.",
        backstory: BACKSTORY,
        difficulty: "easy",
        topic: TOPIC,
        tags: [],
      },
      ACTOR,
      { status: "active" },
    );

    // Put it in a real Q Set, the way the product does.
    const category = await createCategory({ title: "Dedupe QSet Subject" }, ACTOR);
    const set = await createSet({ categoryId: category.id, title: "Tech Founders" }, ACTOR);
    await attachQuestions(set.id, [existing.id], ACTOR);

    const job = await newJob(1);
    const d = deps(envelope(question("Which company did Satya Nadella lead as CEO?")));
    await runGenerationStep(job.id, d);

    const [candidate] = await listJobCandidates(job.id);
    expect(candidate!.dedupeStatus).toBe("exact_dup");
    expect(candidate!.rejected).toBe(1);
    expect(candidate!.dedupeMatchedQuestionId).toBe(existing.id);
  });

  it("flags an in-batch repeat as a duplicate of its batch mate", async () => {
    const job = await newJob(2);
    const d = deps(
      envelope(
        question("In-batch repeat probe question?"),
        question("IN-BATCH REPEAT PROBE QUESTION?"),
      ),
    );

    const progress = await runGenerationStep(job.id, d);
    expect(progress.producedCount).toBe(2);
    expect(progress.duplicateCount).toBe(1);

    const stored = await listJobCandidates(job.id);
    const second = stored[1]!;
    expect(second.rejected).toBe(1);
    expect(second.dedupeStatus).toBe("exact_dup");
    expect(second.dedupeReason).toMatch(/this batch/i);
    // The match is its batch mate, not a bank row.
    expect(second.dedupeMatchedQuestionId).toBeNull();
    expect(second.dedupeMatchedStem).toBe(stored[0]!.stem);
  });

  it("lets the reviewer accept a flagged duplicate, which commits by override", async () => {
    await seedBankQuestion("Override probe: which alloy contains the element tungsten?");

    const category = await (await import("@/modules/catalog")).createCategory(
      { title: "Override Subject" },
      ACTOR,
    );
    const set = await (await import("@/modules/catalog")).createSet(
      { categoryId: category.id, title: "Override Set" },
      ACTOR,
    );

    const job = await newJob(1);
    await runGenerationStep(
      job.id,
      deps(envelope(question("OVERRIDE PROBE: WHICH ALLOY CONTAINS THE ELEMENT TUNGSTEN?"))),
    );

    const [candidate] = await listJobCandidates(job.id);
    expect(candidate!.rejected).toBe(1);

    // The reviewer disagrees with the machine.
    await setCandidateRejected(candidate!.id, false, ACTOR);
    const afterAccept = (await listJobCandidates(job.id))[0]!;
    expect(afterAccept.rejected).toBe(0);

    const outcome = await commitJobToSet(job.id, ACTOR, { setId: set.id });
    expect(outcome.promoted).toHaveLength(1);
    expect(outcome.failed).toEqual([]);

    // It is genuinely in the bank now, despite being flagged.
    const rows = await db()
      .select()
      .from(schema.questions)
      .where(eq(schema.questions.generationJobId, job.id));
    expect(rows).toHaveLength(1);
  });
});

// ── failure modes ────────────────────────────────────────────────────────────

describe("failure modes are explicit", () => {
  it("fails the job when the response cannot be parsed", async () => {
    const job = await newJob(1);
    const progress = await runGenerationStep(job.id, deps("this is not json at all"));
    expect(progress.status).toBe("failed");
    expect((await getJob(job.id)).errorCode).toBe("UNPARSEABLE");
  });

  it("fails the job when the provider errors", async () => {
    const job = await newJob(1);
    const d: GenerationDeps = {
      provider: {
        name: "stub",
        async generate() {
          throw new LlmError("Provider exploded.", { code: "PROVIDER_ERROR", status: 500 });
        },
      },
      storage: memoryStorage(),
    };

    const progress = await runGenerationStep(job.id, d);
    expect(progress.status).toBe("failed");
    expect((await getJob(job.id)).errorCode).toBe("PROVIDER_ERROR");
  });

  it("keeps a terminal job terminal when stepped again", async () => {
    const job = await newJob(1);
    const d = deps(envelope(question("Terminal guard question?")));
    await runGenerationStep(job.id, d);
    const again = await runGenerationStep(job.id, d);
    expect(again.status).toBe("succeeded");
    expect(await listJobCandidates(job.id)).toHaveLength(1);
  });
});

// ── commit: the only path into the bank ──────────────────────────────────────

describe("commitJobToSet", () => {
  async function jobWith(count: number, stems: string[]) {
    const job = await newJob(count);
    await runGenerationStep(job.id, deps(envelope(...stems.map((stem) => question(stem)))));
    return job;
  }

  it("inserts ACTIVE questions and attaches them to the Q Set", async () => {
    const category = await createCategory({ title: "AI Commit Subject" }, ACTOR);
    const set = await createSet({ categoryId: category.id, title: "AI Commit Set" }, ACTOR);
    const job = await jobWith(2, ["Commit alpha question?", "Commit bravo question?"]);

    const outcome = await commitJobToSet(job.id, ACTOR, { setId: set.id });

    expect(outcome.promoted).toHaveLength(2);
    expect(outcome.failed).toEqual([]);

    const rows = await db()
      .select()
      .from(schema.questions)
      .where(eq(schema.questions.generationJobId, job.id));
    expect(rows).toHaveLength(2);
    // Active, not "published" — playability comes from the SET being published.
    expect(rows.every((row) => row.status === "active")).toBe(true);
    expect(rows.every((row) => row.origin === "ai")).toBe(true);

    const attached = await db()
      .select({ questionId: schema.questionSetQuestions.questionId })
      .from(schema.questionSetQuestions)
      .where(eq(schema.questionSetQuestions.setId, set.id));
    expect(attached).toHaveLength(2);

    const stored = await getJob(job.id);
    expect(stored.committedSetId).toBe(set.id);
    expect(stored.committedAt).not.toBeNull();
  });

  it("skips rejected candidates", async () => {
    const category = await createCategory({ title: "AI Reject Subject" }, ACTOR);
    const set = await createSet({ categoryId: category.id, title: "AI Reject Set" }, ACTOR);
    const job = await jobWith(2, ["Reject alpha question?", "Reject bravo question?"]);

    const candidates = await listJobCandidates(job.id);
    await setCandidateRejected(candidates[0]!.id, true, ACTOR);

    const outcome = await commitJobToSet(job.id, ACTOR, { setId: set.id });
    expect(outcome.promoted).toHaveLength(1);
    expect(outcome.promoted[0]!.questionId).toBeTruthy();
  });

  it("refuses a second commit of the same batch", async () => {
    const category = await createCategory({ title: "AI Double Subject" }, ACTOR);
    const set = await createSet({ categoryId: category.id, title: "AI Double Set" }, ACTOR);
    const job = await jobWith(1, ["Double commit question?"]);

    await commitJobToSet(job.id, ACTOR, { setId: set.id });
    await expect(commitJobToSet(job.id, ACTOR, { setId: set.id })).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("requires exactly one target", async () => {
    const job = await jobWith(1, ["Target rule question?"]);
    await expect(commitJobToSet(job.id, ACTOR, {})).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });
});

// ── job creation validation ──────────────────────────────────────────────────

describe("createGenerationJob validation", () => {
  it("rejects a non-positive or oversized count", async () => {
    await expect(newJob(0)).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(newJob(51)).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

// ── prompt stats ─────────────────────────────────────────────────────────────

describe("promptVersionStats", () => {
  it("summarises asked / delivered / duplicates per prompt version", async () => {
    const job = await newJob(2);
    await runGenerationStep(job.id, deps(envelope(question("Prompt stats question?"))));

    const stats = await promptVersionStats();
    expect(stats.length).toBeGreaterThan(0);
    const row = stats[0]!;
    expect(row.requested).toBeGreaterThan(0);
    expect(row.produced).toBeGreaterThan(0);
    expect(row.freshRate).toBeGreaterThan(0);
    expect(row.freshRate).toBeLessThanOrEqual(1);
  });
});
