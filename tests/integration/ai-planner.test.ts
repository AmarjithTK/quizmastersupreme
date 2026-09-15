import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { getPlatformProxy } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, setDbForTests } from "@/db/client";
import * as schema from "@/db/schema";
import {
  approveGenerationPlan,
  cancelJob,
  commitJobToSet,
  createGenerationJob,
  getJob,
  listGenerationSegments,
  listJobBatches,
  listJobCandidates,
  listJobRejections,
  planGenerationJob,
  runGenerationStep,
  saveGenerationPlan,
  stubProvider,
  LlmError,
  type GenerationDeps,
  type RawStorage,
} from "@/modules/ai";
import { plannerFixture } from "../helpers/planner-fixture";

const ACTOR = "user__planner_test";
const TOPIC = "AiPlannerTest";
const BACKSTORY = "The mechanism in this question is independently documented and can be checked from the source context. The distinction between the options matters in practical applications. This example provides memorable context without merely repeating the correct answer.";

let proxy: { env: { DB: D1Database }; dispose: () => Promise<void> } | null = null;

function memoryStorage(): RawStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, async put(key, value) { map.set(key, value); }, async get(key) { return map.get(key) ?? null; } };
}

function generatedQuestion(index: number, segmentId: string, overrides: Record<string, unknown> = {}) {
  return {
    stem: `Which distinct ${segmentId} mechanism explains test scenario ${index}?`,
    options: [
      { key: "A", body: `Correct mechanism ${index}` },
      { key: "B", body: `Plausible alternative ${index}` },
      { key: "C", body: `Second alternative ${index}` },
      { key: "D", body: `Third alternative ${index}` },
    ],
    correct_option_key: "A",
    explanation: `Mechanism ${index} is the applicable one.`,
    backstory: BACKSTORY,
    difficulty: "medium",
    topic: TOPIC,
    tags: ["planner-test"],
    segment_id: segmentId,
    entity_key: `entity-${index}`,
    fact_key: `fact-${index}`,
    question_type: "mechanism",
    source_ids: [],
    ...overrides,
  };
}

function envelope(...questions: unknown[]): string { return JSON.stringify({ questions }); }

async function newPlannedJob(count = 10) {
  return createGenerationJob({
    topic: TOPIC,
    brief: "Write mechanism questions balanced across both coverage areas.",
    requestedCount: count,
    model: "stub/model",
    batchSize: 5,
    groundingMode: "off",
    planningEnabled: true,
  }, ACTOR);
}

async function readyJob(count = 10) {
  const job = await newPlannedJob(count);
  const storage = memoryStorage();
  const planned = await planGenerationJob(job, {
    provider: stubProvider(() => JSON.stringify(plannerFixture())),
    storage,
  });
  const approved = await approveGenerationPlan(planned, ACTOR);
  return { job: approved, storage };
}

beforeAll(async () => {
  proxy = await getPlatformProxy<{ DB: D1Database }>({
    configPath: "wrangler.jsonc", persist: { path: ".tooling/test-state" },
  });
  setDbForTests(drizzle(proxy.env.DB, { schema }));
});

afterAll(async () => {
  const jobs = await db().select({ id: schema.aiGenerationJobs.id }).from(schema.aiGenerationJobs)
    .where(eq(schema.aiGenerationJobs.topic, TOPIC));
  for (const job of jobs) await db().delete(schema.aiGenerationJobs).where(eq(schema.aiGenerationJobs.id, job.id));
  await proxy?.dispose();
  setDbForTests(null);
});

describe("plan-first generation on D1", () => {
  it("requires approval, persists exact quotas, and freezes the plan after generation starts", async () => {
    const job = await newPlannedJob();
    await expect(runGenerationStep(job.id, {
      provider: stubProvider(() => envelope(generatedQuestion(1, "area-one"))), storage: memoryStorage(),
    })).rejects.toThrow("Build the generation plan");

    const storage = memoryStorage();
    const planned = await planGenerationJob(job, {
      provider: stubProvider(() => JSON.stringify(plannerFixture())), storage,
    });
    expect(planned.phase).toBe("awaiting_approval");
    expect(planned.planRevision).toBe(1);
    expect(storage.map.has(`ai-jobs/${job.id}/plan-r1.json`)).toBe(true);
    const segments = await listGenerationSegments(job.id, 1);
    expect(segments.reduce((sum, segment) => sum + segment.targetCount, 0)).toBe(10);

    const revised = await saveGenerationPlan(planned, plannerFixture(), ACTOR);
    expect(revised.planRevision).toBe(2);
    const approved = await approveGenerationPlan(revised, ACTOR);
    expect(approved.phase).toBe("grounding");
    await expect(saveGenerationPlan({ ...approved, backfillRound: 1 }, plannerFixture(), ACTOR)).rejects.toThrow("started");
  });

  it("accounts for every raw item and stores schema/content/policy failures", async () => {
    const { job, storage } = await readyJob();
    const questions = [
      generatedQuestion(101, "area-one"),
      { broken: true },
      generatedQuestion(102, "area-two", { options: Array(4).fill({ key: "A", body: "Repeated" }) }),
      generatedQuestion(103, "unknown-segment"),
      generatedQuestion(104, "area-one", { question_type: "biography" }),
    ];
    const progress = await runGenerationStep(job.id, { provider: stubProvider(() => envelope(...questions)), storage });
    expect(progress.round).toBe(1);
    const [batch] = await listJobBatches(job.id);
    expect(batch?.asked).toBe(5);
    expect(batch?.rawItemCount).toBe(5);
    expect(batch?.schemaInvalidCount).toBe(1);
    expect(batch?.contentInvalidCount).toBe(1);
    expect(batch?.policyRejectedCount).toBe(2);
    expect(batch?.accepted).toBe(1);
    expect(batch?.rawItemCount).toBe((batch?.schemaValidCount ?? 0) + (batch?.schemaInvalidCount ?? 0));
    expect(batch?.contentValidCount).toBe((batch?.policyValidCount ?? 0) + (batch?.policyRejectedCount ?? 0));
    const rejections = await listJobRejections(job.id);
    expect(rejections.map((row) => row.stage).sort()).toEqual(["content", "policy", "policy", "schema"]);
    const candidates = await listJobCandidates(job.id);
    expect(candidates).toHaveLength(3);
    expect(candidates.filter((row) => row.rejectionKind === "policy")).toHaveLength(2);
    expect(storage.map.has(`ai-jobs/${job.id}/request-r1.json`)).toBe(true);
    expect(storage.map.has(`ai-jobs/${job.id}/provider-r1.json`)).toBe(true);
  });

  it("allows only one generation provider call under concurrent steps", async () => {
    const { job, storage } = await readyJob();
    let release!: (value: string) => void;
    let invoked!: () => void;
    const started = new Promise<void>((resolve) => { invoked = resolve; });
    const deferred = new Promise<string>((resolve) => { release = resolve; });
    let calls = 0;
    const provider: GenerationDeps["provider"] = {
      name: "deferred",
      async generate() {
        calls++;
        invoked();
        return { text: await deferred, model: "stub/model", promptTokens: 1, completionTokens: 1, raw: {} };
      },
    };
    const first = runGenerationStep(job.id, { provider, storage });
    await started;
    await expect(runGenerationStep(job.id, { provider, storage })).rejects.toThrow("already running");
    release(envelope(generatedQuestion(201, "area-one")));
    await first;
    expect(calls).toBe(1);
    expect((await listJobBatches(job.id))).toHaveLength(1);
  });

  it("does not allow commit while generation remains active", async () => {
    const { job, storage } = await readyJob();
    await runGenerationStep(job.id, { provider: stubProvider(() => envelope(generatedQuestion(301, "area-one"))), storage });
    await expect(commitJobToSet(job.id, ACTOR, { setId: "unused-set" })).rejects.toThrow("only after generation has stopped");
  });

  it("rejects off-topic biography even when the model supplies a valid segment tag", async () => {
    const { job, storage } = await readyJob();
    const biography = generatedQuestion(401, "area-one", {
      stem: "Where was the technology leader in this test born?",
      options: [
        { key: "A", body: "Pune" }, { key: "B", body: "Kochi" },
        { key: "C", body: "Jaipur" }, { key: "D", body: "Delhi" },
      ],
    });
    await runGenerationStep(job.id, { provider: stubProvider(() => envelope(biography)), storage });
    const candidates = await listJobCandidates(job.id);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.rejected).toBe(1);
    expect(candidates[0]?.rejectionKind).toBe("policy");
    expect(candidates[0]?.rejectionReason).toMatch(/biography/);
    expect((await getJob(job.id)).acceptedCount).toBe(0);
  });

  it("enforces question-type quotas in counted candidates", async () => {
    const job = await newPlannedJob();
    const blueprint = plannerFixture();
    blueprint.globalPolicy.requiredQuestionTypes = [
      { type: "mechanism", targetShare: 0.5 },
      { type: "application", targetShare: 0.5 },
    ];
    const planned = await planGenerationJob(job, { provider: stubProvider(() => JSON.stringify(blueprint)), storage: memoryStorage() });
    await approveGenerationPlan(planned, ACTOR);
    const allMechanism = [
      generatedQuestion(501, "area-one"), generatedQuestion(502, "area-two"),
      generatedQuestion(503, "area-one"), generatedQuestion(504, "area-two"),
      generatedQuestion(505, "area-one"),
    ];
    await runGenerationStep(job.id, { provider: stubProvider(() => envelope(...allMechanism)), storage: memoryStorage() });
    const [batch] = await listJobBatches(job.id);
    const directive = JSON.parse(batch!.directiveJson!) as { questionTypeCounts: Record<string, number> };
    const mechanismQuota = directive.questionTypeCounts.mechanism ?? 0;
    expect(Object.values(directive.questionTypeCounts).reduce((sum, value) => sum + value, 0)).toBe(5);
    expect(batch?.accepted).toBe(mechanismQuota);
    expect(batch?.policyRejectedCount).toBe(5 - mechanismQuota);
  });

  it("stops as SOURCE_LIMITED before generation when current segments lack evidence", async () => {
    const job = await newPlannedJob();
    const blueprint = plannerFixture();
    blueprint.interpretation.freshness = "current";
    const planned = await planGenerationJob(job, { provider: stubProvider(() => JSON.stringify(blueprint)), storage: memoryStorage() });
    await approveGenerationPlan(planned, ACTOR);
    let generationCalls = 0;
    const progress = await runGenerationStep(job.id, {
      provider: stubProvider(() => { generationCalls++; return envelope(generatedQuestion(601, "area-one")); }),
      storage: memoryStorage(),
    });
    expect(progress.status).toBe("failed");
    expect((await getJob(job.id)).errorCode).toBe("SOURCE_LIMITED");
    expect(generationCalls).toBe(0);
    expect(await listJobBatches(job.id)).toHaveLength(0);
  });

  it("admits only cited web facts and never invents a segment for an unscoped claim", async () => {
    const job = await createGenerationJob({
      topic: TOPIC, brief: "Ground both mechanism segments using cited sources.",
      requestedCount: 10, model: "stub/model", batchSize: 5,
      groundingMode: "single", planningEnabled: true,
    }, ACTOR);
    const storage = memoryStorage();
    const planned = await planGenerationJob(job, { provider: stubProvider(() => JSON.stringify(plannerFixture())), storage });
    await approveGenerationPlan(planned, ACTOR);
    const citedUrl = "https://example.org/area-one";
    const researchText = JSON.stringify({ summary: "Cited fixture", facts: [
      { segment_id: "area-one", subject: "Area one", fact: "Area-one mechanism fact", source_url: citedUrl },
      { segment_id: "area-two", subject: "Area two", fact: "Unverified area-two claim", source_url: "https://example.org/not-cited" },
      { subject: "General", fact: "Unscoped cited claim", source_url: citedUrl },
    ] });
    const groundingProvider: GenerationDeps["provider"] = {
      name: "research-fixture",
      async generate(request) {
        expect(request.tools?.[0]?.type).toBe("openrouter:web_search");
        return {
          text: researchText, model: request.model,
          promptTokens: 100, completionTokens: 50, finishReason: "stop",
          citations: [{ url: citedUrl }], raw: { fixture: true },
        };
      },
    };
    await runGenerationStep(job.id, {
      provider: stubProvider(() => envelope()), groundingProvider, storage,
    });
    const facts = await db().select().from(schema.aiSourceFacts).where(eq(schema.aiSourceFacts.jobId, job.id));
    expect(facts).toHaveLength(2);
    expect(facts.every((fact) => fact.sourceUrl === citedUrl)).toBe(true);
    expect(facts.filter((fact) => fact.segmentId === null)).toHaveLength(1);
    const segments = await listGenerationSegments(job.id, 1);
    expect(segments.find((segment) => segment.key === "area-one")?.sourceFactCount).toBe(1);
    expect(segments.find((segment) => segment.key === "area-two")?.sourceFactCount).toBe(0);
  });

  it("records JSON-object fallback when a route refuses strict JSON Schema", async () => {
    const { job, storage } = await readyJob();
    const requests: Array<{ responseSchema?: unknown }> = [];
    const provider: GenerationDeps["provider"] = {
      name: "strict-fallback",
      async generate(request) {
        requests.push(request);
        if (request.responseSchema) throw new LlmError("Structured output unsupported", { code: "PROVIDER_ERROR", status: 400 });
        return { text: envelope(generatedQuestion(701, "area-one")), model: "stub/model", promptTokens: 30, completionTokens: 100, raw: {} };
      },
    };
    await runGenerationStep(job.id, { provider, storage });
    expect(requests).toHaveLength(2);
    expect(requests[0]?.responseSchema).toBeDefined();
    expect(requests[1]?.responseSchema).toBeUndefined();
    const [batch] = await listJobBatches(job.id);
    expect(batch?.responseFormatMode).toBe("json_object_fallback");
    const manifest = JSON.parse(storage.map.get(`ai-jobs/${job.id}/request-r1.json`)!) as { attemptedRequests: unknown[] };
    expect(manifest.attemptedRequests).toHaveLength(2);
  });

  it("recovers an expired running batch without reusing its batch number", async () => {
    const { job, storage } = await readyJob();
    await db().update(schema.aiGenerationJobs).set({
      status: "running", phase: "generating", leaseToken: "stale-lease", leaseExpiresAt: Date.now() - 1,
    }).where(eq(schema.aiGenerationJobs.id, job.id));
    await db().insert(schema.aiGenerationBatches).values({
      id: crypto.randomUUID(), jobId: job.id, batchNo: 1, status: "running", asked: 5,
      leaseToken: "stale-lease", startedAt: Date.now() - 2_000,
    });
    await runGenerationStep(job.id, { provider: stubProvider(() => envelope(generatedQuestion(801, "area-one"))), storage });
    const batches = await listJobBatches(job.id);
    expect(batches.map((batch) => batch.batchNo)).toEqual([1, 2]);
    expect(batches[0]?.status).toBe("failed");
    expect(batches[0]?.errorCode).toBe("INTERRUPTED");
    expect(batches[1]?.status).toBe("succeeded");
  });

  it("fences a late model response after cancellation", async () => {
    const { job, storage } = await readyJob();
    let release!: (value: string) => void;
    let invoked!: () => void;
    const started = new Promise<void>((resolve) => { invoked = resolve; });
    const deferred = new Promise<string>((resolve) => { release = resolve; });
    const provider: GenerationDeps["provider"] = {
      name: "late-provider",
      async generate() { invoked(); return { text: await deferred, model: "stub/model", promptTokens: 1, completionTokens: 1, raw: {} }; },
    };
    const pending = runGenerationStep(job.id, { provider, storage });
    await started;
    await cancelJob(job.id, ACTOR);
    release(envelope(generatedQuestion(901, "area-one")));
    await expect(pending).rejects.toThrow("lease was lost");
    expect(await listJobCandidates(job.id)).toHaveLength(0);
    expect((await getJob(job.id)).status).toBe("cancelled");
  });
});
