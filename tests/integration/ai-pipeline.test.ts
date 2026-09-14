/**
 * AI generation pipeline against real D1, with a STUB provider.
 *
 * No network, no API key: the pipeline takes its provider as an argument, which
 * is exactly why it is testable at all. What is verified here is the REVAMPED
 * contract:
 *
 *   1. A job runs in SMALL INTERNAL BATCHES (default 25) and refills until the
 *      accepted count reaches the target (PIPELINE-PLAN.md P0).
 *   2. Duplicates are stored but arrive REJECTED BY DEFAULT, with the question
 *      they matched — never hidden.
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
  listJobBatches,
  listJobCandidates,
  outputBudgetFor,
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
    await db()
      .delete(schema.aiGenerationBatches)
      .where(eq(schema.aiGenerationBatches.jobId, job.id))
      .run();
    await db().delete(schema.aiGenerationJobs).where(eq(schema.aiGenerationJobs.id, job.id)).run();
  }
  await db().delete(schema.questions).where(eq(schema.questions.topic, TOPIC)).run();
}

async function newJob(count = 3, model = "stub/model", batchSize?: number) {
  return createGenerationJob(
    {
      topic: TOPIC,
      brief: "Write test questions.",
      requestedCount: count,
      model,
      batchSize: batchSize ?? null,
    },
    ACTOR,
  );
}

/** Step until the job is terminal, with a hard guard against a runaway loop. */
async function drain(jobId: string, d: GenerationDeps, max = 40) {
  let progress = await runGenerationStep(jobId, d);
  let guard = 0;
  while (!progress.done && guard++ < max) {
    progress = await runGenerationStep(jobId, d);
  }
  return progress;
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

  it("stops early and says so when every batch is already in the bank", async () => {
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

    // Every batch comes back as questions the bank already has.
    const job = await newJob(2);
    const d = deps(
      envelope(question("Saturated topic question?"), question("Saturated topic question?")),
    );

    const progress = await drain(job.id, d);

    expect(progress.done).toBe(true);
    expect(progress.status).toBe("partial");
    // Nothing was accepted, but the duplicates were NOT hidden.
    expect(progress.acceptedCount).toBe(0);
    expect(progress.producedCount).toBe(4);
    expect(progress.duplicateCount).toBe(4);
    // It stopped on the stall rule, not by burning every call.
    expect(progress.round).toBeLessThan(job.maxCalls);

    const row = await getJob(job.id);
    expect(row.errorCode).toBe("SATURATED");
    expect(row.errorMessage).toMatch(/covers this topic/i);

    const stored = await listJobCandidates(job.id);
    expect(stored).toHaveLength(4);
    expect(stored.every((c) => c.rejected === 1)).toBe(true);
  });
});

// ── the small-batch loop (PIPELINE-PLAN P0) ──────────────────────────────────

describe("small-batch generation loop", () => {
  /** 25 unique, clean questions per call — the classic large-job shape. */
  const batchOf = (call: number, size = 25) =>
    envelope(...Array.from({ length: size }, (_, i) => question(`Loop probe c${call} q${i}?`)));

  it("splits a 100-question target into 25-question calls and refills to the target", async () => {
    const job = await newJob(100, "stub/model", 25);
    let calls = 0;

    const d: GenerationDeps = {
      provider: stubProvider(() => batchOf(++calls)),
      storage: memoryStorage(),
    };

    const progress = await drain(job.id, d);

    expect(progress.done).toBe(true);
    expect(progress.status).toBe("succeeded");
    expect(calls).toBe(4); // 100 ÷ 25
    expect(progress.acceptedCount).toBe(100);
    expect(progress.producedCount).toBe(100);
    expect(progress.round).toBe(4);

    // Every call left its own record with its own counts.
    const batches = await listJobBatches(job.id);
    expect(batches).toHaveLength(4);
    expect(batches.map((b) => b.batchNo)).toEqual([1, 2, 3, 4]);
    expect(batches.every((b) => b.asked === 25 && b.status === "succeeded")).toBe(true);
    expect(batches.every((b) => b.produced === 25 && b.accepted === 25)).toBe(true);
    expect(batches.every((b) => b.rawResponseKey != null && b.finishedAt != null)).toBe(true);
  });

  it("feeds the concepts accepted earlier in the job into the next prompt", async () => {
    const job = await newJob(50, "stub/model", 25);
    const prompts: string[] = [];
    let calls = 0;

    const d: GenerationDeps = {
      provider: stubProvider((request) => {
        calls++;
        prompts.push(request.user);
        return batchOf(calls);
      }),
      storage: memoryStorage(),
    };

    await drain(job.id, d);

    // The first call has no job-local memory; the second one does.
    expect(prompts[0]).not.toContain("ALREADY GENERATED IN THIS JOB");
    expect(prompts[1]).toContain("ALREADY GENERATED IN THIS JOB");
    expect(prompts[1]).toContain("loop probe c1 q0");
  });

  it("stops at the call cap and reports a partial rather than running forever", async () => {
    const job = await newJob(100, "stub/model", 25);
    let calls = 0;

    const d: GenerationDeps = {
      provider: stubProvider(() => envelope(question(`Cap probe call ${++calls}?`))),
      storage: memoryStorage(),
    };

    const progress = await drain(job.id, d, 60);

    expect(progress.done).toBe(true);
    expect(progress.status).toBe("partial");
    expect(progress.round).toBe(job.maxCalls);
    expect(progress.acceptedCount).toBe(job.maxCalls);

    const row = await getJob(job.id);
    expect(row.errorCode).toBe("MAX_CALLS");
    expect(row.errorMessage).toMatch(/call limit/i);
  });

  it("retries a retryable provider failure once before giving up", async () => {
    const job = await newJob(25, "stub/model", 25);
    let attempts = 0;

    const d: GenerationDeps = {
      provider: {
        name: "flaky",
        async generate(request) {
          attempts++;
          if (attempts === 1) {
            throw new LlmError("Slow down.", { code: "RATE_LIMITED", retryable: true });
          }
          return {
            text: batchOf(1),
            model: request.model,
            promptTokens: 10,
            completionTokens: 10,
            raw: {},
          };
        },
      },
      storage: memoryStorage(),
    };

    const progress = await drain(job.id, d);
    expect(attempts).toBe(2);
    expect(progress.status).toBe("succeeded");
    expect(progress.acceptedCount).toBe(25);
  });
});

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
    expect(second.dedupeReason).toMatch(/in this job/i);
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

  it("auto-trims an overshoot so the Q Set receives exactly the target (D1)", async () => {
    const category = await createCategory({ title: "Trim Subject" }, ACTOR);
    const set = await createSet({ categoryId: category.id, title: "Trim Set" }, ACTOR);

    // Target 3, but the refill floor asks for 5 and the model complies with 5 —
    // so the job succeeds with 5 accepted and the commit trims to 3.
    const job = await newJob(3);
    await runGenerationStep(
      job.id,
      deps(
        envelope(
          question("Trim alpha question?"),
          question("Trim bravo question?"),
          question("Trim charlie question?"),
          question("Trim delta question?"),
          question("Trim echo question?"),
        ),
      ),
    );
    const afterRun = await getJob(job.id);
    expect(afterRun.status).toBe("succeeded");
    expect(afterRun.acceptedCount).toBe(5);

    const outcome = await commitJobToSet(job.id, ACTOR, { setId: set.id });
    expect(outcome.promoted).toHaveLength(3);
    expect(outcome.questionIds).toHaveLength(3);

    const attached = await db()
      .select({ questionId: schema.questionSetQuestions.questionId })
      .from(schema.questionSetQuestions)
      .where(eq(schema.questionSetQuestions.setId, set.id));
    expect(attached).toHaveLength(3);

    // The two overflow questions stay in the working set, accepted and unused.
    const stored = await listJobCandidates(job.id);
    expect(stored.filter((c) => c.rejected === 0)).toHaveLength(5);
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
  it("rejects a non-positive count and anything past the configured ceiling", async () => {
    await expect(newJob(0)).rejects.toMatchObject({ code: "VALIDATION" });
    // Default ceiling is generation.max_requested = 300.
    await expect(newJob(301)).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("honours a per-job batch size and derives the call cap from it", async () => {
    const job = await newJob(100, "stub/model", 20);
    expect(job.batchSize).toBe(20);
    // ceil(100/20) = 5 planned calls, plus refill slack.
    expect(job.maxCalls).toBeGreaterThanOrEqual(8);
  });
});
