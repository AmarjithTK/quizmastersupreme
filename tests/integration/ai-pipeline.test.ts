/**
 * AI generation pipeline (M10) against real D1, with a STUB provider.
 *
 * No network, no API key: the pipeline takes its provider as an argument, which
 * is exactly why it is testable at all. What is being verified is the machinery
 * — two bounded steps, the repair chain, dedupe, the candidate table, and the
 * promotion path.
 *
 * The single most important assertion here is that generating questions NEVER
 * writes to `questions` (PLAN.md §2.2). Everything else is detail.
 */

import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { getPlatformProxy } from "wrangler";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, setDbForTests } from "@/db/client";
import * as schema from "@/db/schema";
import {
  createGenerationJob,
  promptVersionStats,
  getJob,
  listCandidates,
  promoteCandidate,
  reviewCandidate,
  runGenerationStep,
  stubProvider,
  type GenerationDeps,
  type GenerationRequest,
  type RawStorage,
} from "@/modules/ai";

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

function deps(text: string): GenerationDeps & { storage: ReturnType<typeof memoryStorage> } {
  return {
    provider: stubProvider(() => text),
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

async function newJob(count = 3) {
  return createGenerationJob(
    { topic: TOPIC, brief: "Write test questions.", requestedCount: count, model: "stub/model" },
    ACTOR,
  );
}

// ── §2.2 — the hard rule ─────────────────────────────────────────────────────

describe("§2.2 AI output is never published content", () => {
  it("NEVER writes to the questions table, however the job ends", async () => {
    const before = await countQuestions();

    const job = await newJob(3);
    const d = deps(envelope(question("Ai pipeline never publishes question one?"), question("Ai pipeline never publishes question two?")));

    await runGenerationStep(job.id, d);
    await runGenerationStep(job.id, d);

    const after = await countQuestions();
    expect(after).toBe(before);

    const found = await db()
      .select()
      .from(schema.questions)
      .where(eq(schema.questions.topic, TOPIC));
    expect(found).toHaveLength(0);

    // The candidates landed in the candidate table instead.
    const candidates = await listCandidates({ jobId: job.id });
    expect(candidates).toHaveLength(2);
    expect(candidates.every((c) => c.reviewStatus === "pending")).toBe(true);
  });
});

// ── the two bounded steps ────────────────────────────────────────────────────

describe("two bounded generation steps", () => {
  it("moves queued → running → succeeded, archiving the raw response", async () => {
    const job = await newJob(2);
    expect(job.status).toBe("queued");

    const d = deps(envelope(question("Ai pipeline staging question?")));

    const afterStepOne = await runGenerationStep(job.id, d);
    expect(afterStepOne.status).toBe("running");
    expect(afterStepOne.done).toBe(false);

    const stored = await getJob(job.id);
    expect(stored.rawResponseKey).toBeTruthy();
    // The raw payload is archived so a bad batch can be diagnosed later.
    expect(d.storage.map.get(stored.rawResponseKey!)).toContain("questions");

    const afterStepTwo = await runGenerationStep(job.id, d);
    expect(afterStepTwo.status).toBe("succeeded");
    expect(afterStepTwo.done).toBe(true);
    expect(afterStepTwo.producedCount).toBe(1);
  });

  it("records token usage and an estimated cost", async () => {
    const job = await newJob(1);
    const d = deps(envelope(question("Ai pipeline cost question?")));
    await runGenerationStep(job.id, d);

    const stored = await getJob(job.id);
    expect(stored.promptTokens).toBeGreaterThan(0);
    expect(stored.completionTokens).toBeGreaterThan(0);
    expect(stored.costUsd).toBeGreaterThan(0);
  });

  it("is idempotent once terminal — calling step again changes nothing", async () => {
    const job = await newJob(1);
    const d = deps(envelope(question("Ai pipeline idempotent question?")));
    await runGenerationStep(job.id, d);
    await runGenerationStep(job.id, d);

    const before = await listCandidates({ jobId: job.id });
    const again = await runGenerationStep(job.id, d);
    const after = await listCandidates({ jobId: job.id });

    expect(again.done).toBe(true);
    expect(after).toHaveLength(before.length);
  });

  it("fails cleanly when the provider throws", async () => {
    const job = await newJob(1);
    const failing: GenerationDeps = {
      provider: {
        name: "stub",
        async generate() {
          throw new Error("upstream exploded");
        },
      },
      storage: memoryStorage(),
    };

    const progress = await runGenerationStep(job.id, failing);
    expect(progress.status).toBe("failed");
    expect(progress.done).toBe(true);

    const stored = await getJob(job.id);
    expect(stored.errorCode).toBe("PROVIDER_ERROR");
    // And no candidates were invented.
    expect(await listCandidates({ jobId: job.id })).toHaveLength(0);
  });

  it("fails cleanly when the archived response is missing", async () => {
    const job = await newJob(1);
    // Force it into the ingest stage with a key that resolves to nothing.
    await db()
      .update(schema.aiGenerationJobs)
      .set({ status: "running", rawResponseKey: "ai-jobs/missing/response.txt" })
      .where(eq(schema.aiGenerationJobs.id, job.id))
      .run();

    const progress = await runGenerationStep(job.id, deps("{}"));
    expect(progress.status).toBe("failed");
    expect(progress.error).toMatch(/could not be read/i);
  });
});

// ── validation and dedupe at candidate time ──────────────────────────────────

describe("candidate validation and dedupe", () => {
  it("stores invalid candidates WITH their errors instead of dropping them", async () => {
    const job = await newJob(3);
    const d = deps(
      envelope(
        question("Ai pipeline valid among invalid?"),
        question("Ai pipeline bad options?", { options: [{ key: "A", body: "only one" }] }),
        question("Ai pipeline short backstory?", { backstory: "nope" }),
      ),
    );

    await runGenerationStep(job.id, d);
    const progress = await runGenerationStep(job.id, d);
    expect(progress.status).toBe("partial");

    const candidates = await listCandidates({ jobId: job.id });
    expect(candidates).toHaveLength(3);

    const invalid = candidates.filter((c) => c.validationStatus === "invalid");
    expect(invalid).toHaveLength(2);
    for (const candidate of invalid) {
      const errors = JSON.parse(candidate.validationErrors!) as string[];
      expect(errors.length).toBeGreaterThan(0);
      // The stem is preserved where the model provided one, so it is reviewable.
      expect(candidate.stem).toBeTruthy();
    }
  });

  it("flags a candidate that duplicates an existing question", async () => {
    // Put a real question in the bank first.
    const { createQuestion } = await import("@/modules/questions");
    await createQuestion(
      {
        stem: "Ai pipeline duplicate target question?",
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
      { status: "published" },
    );

    const job = await newJob(1);
    // Same stem, different casing/punctuation → identical after normalization.
    const d = deps(envelope(question("AI PIPELINE DUPLICATE TARGET QUESTION")));
    await runGenerationStep(job.id, d);
    await runGenerationStep(job.id, d);

    const candidates = await listCandidates({ jobId: job.id });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.dedupeStatus).toBe("exact_dup");
    expect(candidates[0]!.dedupeBestMatchId).toBeTruthy();

    const stored = await getJob(job.id);
    expect(stored.duplicateCount).toBe(1);
  });
});

// ── promotion: the only route into the bank ──────────────────────────────────

describe("promotion", () => {
  it("adds an approved candidate to the bank as an AI-origin question", async () => {
    const job = await newJob(1);
    const d = deps(envelope(question("Ai pipeline promotion candidate?")));
    await runGenerationStep(job.id, d);
    await runGenerationStep(job.id, d);

    const candidate = (await listCandidates({ jobId: job.id }))[0]!;
    await reviewCandidate(candidate.id, "approved", ACTOR);

    const { questionId } = await promoteCandidate(candidate.id, ACTOR);

    const stored = (await db().select().from(schema.questions).where(eq(schema.questions.id, questionId)))[0]!;
    expect(stored.origin).toBe("ai");
    // Approved, NOT published — publishing stays a separate deliberate action.
    expect(stored.status).toBe("approved");
    expect(stored.normalizedHash).toMatch(/^[0-9a-f]{64}$/);

    const options = await db()
      .select()
      .from(schema.questionOptions)
      .where(eq(schema.questionOptions.questionId, questionId));
    expect(options).toHaveLength(4);
    expect(options.filter((o) => o.isCorrect === 1)).toHaveLength(1);
  });

  it("refuses to promote an INVALID candidate", async () => {
    const job = await newJob(1);
    const d = deps(envelope(question("Ai pipeline invalid promotion?", { options: [{ key: "A", body: "x" }] })));
    await runGenerationStep(job.id, d);
    await runGenerationStep(job.id, d);

    const candidate = (await listCandidates({ jobId: job.id }))[0]!;
    expect(candidate.validationStatus).toBe("invalid");

    await expect(promoteCandidate(candidate.id, ACTOR)).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("refuses to promote the same candidate twice", async () => {
    const job = await newJob(1);
    const d = deps(envelope(question("Ai pipeline double promotion?")));
    await runGenerationStep(job.id, d);
    await runGenerationStep(job.id, d);

    const candidate = (await listCandidates({ jobId: job.id }))[0]!;
    await promoteCandidate(candidate.id, ACTOR);

    await expect(promoteCandidate(candidate.id, ACTOR)).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("refuses to promote a REJECTED candidate", async () => {
    const job = await newJob(1);
    const d = deps(envelope(question("Ai pipeline rejected promotion?")));
    await runGenerationStep(job.id, d);
    await runGenerationStep(job.id, d);

    const candidate = (await listCandidates({ jobId: job.id }))[0]!;
    await reviewCandidate(candidate.id, "rejected", ACTOR);

    await expect(promoteCandidate(candidate.id, ACTOR)).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });
});
async function resetAiTables(): Promise<void> {
  const jobs = await db().select({ id: schema.aiGenerationJobs.id }).from(schema.aiGenerationJobs);
  for (const job of jobs) {
    await db().delete(schema.aiCandidates).where(eq(schema.aiCandidates.jobId, job.id)).run();
    await db().delete(schema.aiGenerationJobs).where(eq(schema.aiGenerationJobs.id, job.id)).run();
  }
}

describe("promptVersionStats — M13 acceptance reporting", () => {
  beforeEach(resetAiTables);

  it("breaks down decisions by prompt_version, excluding pending from the denominator", async () => {
    // Seed one job + candidates directly (no LLM needed) under a unique topic.
    const uid = `stats_${Date.now()}`;
    const job = await createGenerationJob(
      {
        topic: uid,
        brief: "Make questions.",
        requestedCount: 4,
        model: "stub",
        subtopics: null,
        avoidTopics: null,
        difficulty: "easy",
        targetCategoryId: null,
        targetSetId: null,
      },
      ACTOR,
    );
    // Insert 4 candidates: 2 approved, 1 rejected, 1 pending → acceptance 2/3.
    const base = { jobId: job.id, optionsJson: '[{"key":"A","body":"x"}]', correctOptionKey: "A", explanation: "e", backstory: "b", topic: uid, validationStatus: "valid", dedupeStatus: "clean" };
    for (let i = 0; i < 4; i++) {
      await db().insert(schema.aiCandidates).values({ ...base, id: `${job.id}_c${i}`, stem: `Stem ${uid} ${i}?`, createdAt: Date.now() }).run();
    }
    const cands = await db().select({ id: schema.aiCandidates.id }).from(schema.aiCandidates).where(eq(schema.aiCandidates.jobId, job.id)).all();
    await reviewCandidate(cands[0]!.id, "approved", ACTOR);
    await reviewCandidate(cands[1]!.id, "approved", ACTOR);
    await reviewCandidate(cands[2]!.id, "rejected", ACTOR);

    const stats = await promptVersionStats();
    const row = stats.find((r) => r.promptVersion === job.promptVersion && r.jobs === 1);
    expect(row).toBeTruthy();
    expect(row!.produced).toBe(4);
    expect(row!.approved).toBe(2);
    expect(row!.rejected).toBe(1);
    expect(row!.pending).toBe(1);
    expect(row!.acceptanceRate).toBeCloseTo(2 / 3, 5);
    expect(row!.duplicateRate).toBe(0);

  });

  it("does not count deferred candidates against acceptance", async () => {
    const uid = `stats_defer_${Date.now()}`;
    const job = await createGenerationJob({ topic: uid, brief: "x", requestedCount: 1, model: "stub", subtopics: null, avoidTopics: null, difficulty: "easy", targetCategoryId: null, targetSetId: null }, ACTOR);
    await db().insert(schema.aiCandidates).values({ id: `${job.id}_d0`, jobId: job.id, stem: `Deferred ${uid}?`, optionsJson: '[{"key":"A","body":"x"}]', correctOptionKey: "A", explanation: "e", backstory: "b", topic: uid, validationStatus: "valid", dedupeStatus: "clean", createdAt: Date.now() }).run();
    const cands = await db().select({ id: schema.aiCandidates.id }).from(schema.aiCandidates).where(eq(schema.aiCandidates.jobId, job.id)).all();
    await reviewCandidate(cands[0]!.id, "deferred", ACTOR);

    const stats = await promptVersionStats();
    const row = stats.find((r) => r.jobs === 1 && r.produced === 1);
    expect(row).toBeTruthy();
    expect(row!.acceptanceRate).toBeNull(); // nothing decided yet
    expect(row!.deferred).toBe(1);
  });
});


describe("provider routing forwarding (only/order)", () => {
  it("passes the job's saved routing into the provider request", async () => {
    const job = await createGenerationJob(
      {
        topic: TOPIC,
        brief: "Write test questions.",
        requestedCount: 1,
        model: "stub/model",
        providerOnly: ["together", "deepinfra"],
        providerOrder: ["together"],
      },
      ACTOR,
    );

    let seenRequest: GenerationRequest | null = null;
    await runGenerationStep(job.id, {
      provider: stubProvider((request) => {
        seenRequest = request;
        return envelope(question("Routing forwarded?"));
      }),
      storage: memoryStorage(),
    });

    expect(seenRequest).not.toBeNull();
    expect(seenRequest!.providerOnly).toEqual(["together", "deepinfra"]);
    expect(seenRequest!.providerOrder).toEqual(["together"]);

    await db().delete(schema.aiCandidates).where(eq(schema.aiCandidates.jobId, job.id)).run();
    await db().delete(schema.aiGenerationJobs).where(eq(schema.aiGenerationJobs.id, job.id)).run();
  });

  it("defaults to no routing when the job has none", async () => {
    const job = await createGenerationJob(
      { topic: TOPIC, brief: "Write test questions.", requestedCount: 1, model: "stub/model" },
      ACTOR,
    );

    let seenRequest: GenerationRequest | null = null;
    await runGenerationStep(job.id, {
      provider: stubProvider((request) => {
        seenRequest = request;
        return envelope(question("No routing?"));
      }),
      storage: memoryStorage(),
    });

    expect(seenRequest!.providerOnly).toBeUndefined();
    expect(seenRequest!.providerOrder).toBeUndefined();

    await db().delete(schema.aiCandidates).where(eq(schema.aiCandidates.jobId, job.id)).run();
    await db().delete(schema.aiGenerationJobs).where(eq(schema.aiGenerationJobs.id, job.id)).run();
  });
});

describe("large batches (D1 parameter ceiling)", () => {
  it("ingests 10 candidates in one job — the chunking must respect the ~100-param ceiling", async () => {
    const job = await createGenerationJob(
      { topic: TOPIC, brief: "Write test questions.", requestedCount: 10, model: "stub/model" },
      ACTOR,
    );

    const questions = Array.from({ length: 10 }, (_, i) =>
      question(`Large batch question number ${i + 1}?`),
    );
    const d = deps(envelope(...questions));
    await runGenerationStep(job.id, d);
    await runGenerationStep(job.id, d);

    const candidates = await listCandidates({ jobId: job.id });
    expect(candidates).toHaveLength(10);
    expect(candidates.every((c) => c.validationStatus === "valid")).toBe(true);

    const stored = await getJob(job.id);
    expect(stored.status).toBe("succeeded");
    expect(stored.producedCount).toBe(10);

    await db().delete(schema.aiCandidates).where(eq(schema.aiCandidates.jobId, job.id)).run();
    await db().delete(schema.aiGenerationJobs).where(eq(schema.aiGenerationJobs.id, job.id)).run();
  });
});
