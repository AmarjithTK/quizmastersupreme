/**
 * Grounding (PIPELINE-PLAN.md §8, P2).
 *
 * The rules this file locks:
 *   1. `mode: "off"` never calls the search provider.
 *   2. admin-supplied sources skip the search entirely (cost $0).
 *   3. one research call per job, and every batch reuses the pool as text —
 *      the per-batch generation calls must NEVER carry the web plugin.
 *   4. the pool is cached by topic, so the same topic again costs $0.
 *   5. a failing search never fails the job; it is recorded and the run
 *      continues ungrounded.
 */

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { getPlatformProxy } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, setDbForTests } from "@/db/client";
import * as schema from "@/db/schema";
import {
  createGenerationJob,
  getJob,
  runGenerationStep,
  stubProvider,
  type GenerationDeps,
  type RawStorage,
} from "@/modules/ai";
import {
  GROUNDING_DEFAULTS,
  buildSourcePool,
  groundingCacheKey,
  parseResearch,
  renderSourcePool,
  webPlugin,
} from "@/modules/grounding";
import { updateGenerationSettings } from "@/modules/settings";

const ACTOR = "user__grounding_test";
const TOPIC = "GroundingTestTopic";

const BACKSTORY =
  "A sufficiently long backstory for the grounding tests, written as prose so the schema's " +
  "minimum length is satisfied and the review screen has something real to render.";

const question = (stem: string) => ({
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
  tags: ["grounding-test"],
});

const envelope = (...questions: unknown[]) => JSON.stringify({ questions });

const RESEARCH_JSON = JSON.stringify({
  summary: "Apple has been led by Tim Cook since 2011.",
  facts: [
    { subject: "Apple", fact: "Tim Cook became CEO in 2011.", source_url: "https://apple.com/leadership" },
    { subject: "Google", fact: "Sundar Pichai became CEO in 2015.", source_url: "https://abc.xyz/investor" },
  ],
});

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

/** A grounding provider that records every call and returns a citation. */
function groundingStub() {
  const calls: Array<{ plugins?: Array<Record<string, unknown>> }> = [];
  return {
    calls,
    provider: {
      name: "grounding-stub",
      async generate(request: { plugins?: Array<Record<string, unknown>> }) {
        calls.push({ plugins: request.plugins });
        return {
          text: RESEARCH_JSON,
          model: "stub/model",
          promptTokens: 500,
          completionTokens: 200,
          citations: [{ url: "https://apple.com/leadership", title: "Apple leadership" }],
          raw: {},
        };
      },
    },
  };
}

let proxy: { env: { DB: D1Database }; dispose: () => Promise<void> } | null = null;

beforeAll(async () => {
  proxy = await getPlatformProxy<{ DB: D1Database }>({
    configPath: "wrangler.jsonc",
    persist: { path: ".tooling/test-state" },
  });
  setDbForTests(drizzle(proxy.env.DB, { schema }));
  await cleanup();
  // Grounding is off by default in the product; the tests that need it turn it
  // on explicitly and turn it back off in afterAll.
  await updateGenerationSettings(
    { groundingMode: "single", groundingEngine: "exa", groundingMaxResults: 5, groundingTtlDays: 14 },
    ACTOR,
  );
});

afterAll(async () => {
  await cleanup();
  await updateGenerationSettings({ groundingMode: "off" }, ACTOR);
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
  await db().delete(schema.groundingCache).run();
}

// ── pure helpers ─────────────────────────────────────────────────────────────

describe("grounding helpers", () => {
  it("parses a fact sheet, tolerating a prose wrapper", () => {
    const parsed = parseResearch(`Here you go:\n\`\`\`json\n${RESEARCH_JSON}\n\`\`\``);
    expect(parsed.facts).toHaveLength(2);
    expect(parsed.facts[0]!.fact).toMatch(/Tim Cook/i);
    expect(parsed.facts[0]!.sourceUrl).toBe("https://apple.com/leadership");
  });

  it("keeps non-JSON output as a summary instead of losing it", () => {
    const parsed = parseResearch("Apple: Tim Cook since 2011. Google: Sundar Pichai since 2015.");
    expect(parsed.facts).toEqual([]);
    expect(parsed.summary).toMatch(/Tim Cook/);
  });

  it("builds the web plugin with the configured engine, results and domains", () => {
    const plugin = webPlugin({
      ...GROUNDING_DEFAULTS,
      engine: "parallel",
      maxResults: 3,
      excludeDomains: ["reddit.com"],
    });
    expect(plugin[0]).toMatchObject({
      id: "web",
      engine: "parallel",
      max_results: 3,
      exclude_domains: ["reddit.com"],
    });
  });

  it("keys the cache on the topic and the search shape", async () => {
    const a = await groundingCacheKey("Tech CEOs", GROUNDING_DEFAULTS);
    const b = await groundingCacheKey("  tech   ceos ", GROUNDING_DEFAULTS);
    const c = await groundingCacheKey("Tech CEOs", { ...GROUNDING_DEFAULTS, maxResults: 10 });
    expect(a).toBe(b); // normalised
    expect(a).not.toBe(c); // a different search shape is a different pool
  });

  it("renders a budgeted prompt block", () => {
    const block = renderSourcePool({
      extracts: [{ title: "Apple", url: "", excerpt: "Tim Cook became CEO in 2011." }],
      citations: ["https://apple.com/leadership"],
      queries: ["tech ceos"],
      summary: "Summary line.",
      fetchedAt: 0,
    });
    expect(block).toContain("WEB RESEARCH");
    expect(block).toContain("Tim Cook became CEO in 2011.");
    expect(block).toContain("https://apple.com/leadership");
  });
});

// ── buildSourcePool ──────────────────────────────────────────────────────────

describe("buildSourcePool", () => {
  it("does not search when the mode is off", async () => {
    const stub = groundingStub();
    const result = await buildSourcePool(
      { topic: "Off topic", brief: "", settings: { ...GROUNDING_DEFAULTS, mode: "off" } },
      { provider: stub.provider, model: "stub/model", estimateCostUsd: () => 0 },
    );
    expect(result.skipped).toBe(true);
    expect(result.pool).toBeNull();
    expect(stub.calls).toHaveLength(0);
  });

  it("skips the search when the admin supplied sources", async () => {
    const stub = groundingStub();
    const result = await buildSourcePool(
      {
        topic: "User sourced",
        brief: "",
        userSources: "https://example.com/my-notes",
        settings: { ...GROUNDING_DEFAULTS, mode: "single" },
      },
      { provider: stub.provider, model: "stub/model", estimateCostUsd: () => 0 },
    );
    expect(result.skipped).toBe(true);
    expect(result.costUsd).toBe(0);
    expect(stub.calls).toHaveLength(0);
  });

  it("makes ONE research call, records the search fee, and caches the pool", async () => {
    const stub = groundingStub();
    const settings = { ...GROUNDING_DEFAULTS, mode: "single" as const };
    const deps = { provider: stub.provider, model: "stub/model", estimateCostUsd: () => 0 };

    const first = await buildSourcePool({ topic: "CacheMeTopic", brief: "", settings }, deps);
    expect(stub.calls).toHaveLength(1);
    // The web plugin is what makes it a search call.
    expect(stub.calls[0]!.plugins?.[0]).toMatchObject({ id: "web", engine: "exa" });
    expect(first.pool?.extracts).toHaveLength(2);
    expect(first.pool?.citations).toEqual(["https://apple.com/leadership"]);
    expect(first.costUsd).toBeCloseTo(0.007, 6); // the Exa request fee
    expect(first.cached).toBe(false);

    // Same topic again: no second search, and it is free.
    const second = await buildSourcePool({ topic: "CacheMeTopic", brief: "", settings }, deps);
    expect(stub.calls).toHaveLength(1);
    expect(second.cached).toBe(true);
    expect(second.costUsd).toBe(0);
    expect(second.pool?.extracts).toHaveLength(2);
  });

  it("reports a search failure instead of throwing", async () => {
    const failing = {
      name: "failing",
      async generate() {
        throw new Error("search is down");
      },
    };
    const result = await buildSourcePool(
      { topic: "FailingTopic", brief: "", settings: { ...GROUNDING_DEFAULTS, mode: "single" } },
      { provider: failing, model: "stub/model", estimateCostUsd: () => 0 },
    );
    expect(result.pool).toBeNull();
    expect(result.error).toMatch(/search is down/i);
    expect(result.skipped).toBe(false);
  });
});

// ── the pipeline uses it exactly once, and never per batch ──────────────────

describe("grounding inside a generation job", () => {
  async function newJob(
    count = 25,
    groundingMode: "off" | "single" = "single",
    topic = TOPIC,
  ) {
    return createGenerationJob(
      {
        topic,
        brief: "Write test questions.",
        requestedCount: count,
        model: "stub/model",
        batchSize: 25,
        groundingMode,
      },
      ACTOR,
    );
  }

  it("grounds on the first batch and reuses the pool for the next one", async () => {
    const job = await newJob(50);
    const grounding = groundingStub();
    const generationRequests: Array<{ plugins?: Array<Record<string, unknown>> }> = [];

    const d: GenerationDeps = {
      provider: stubProvider((request) => {
        generationRequests.push({ plugins: request.plugins });
        const call = generationRequests.length;
        return envelope(
          ...Array.from({ length: 25 }, (_, i) => question(`Grounded probe c${call} q${i}?`)),
        );
      }),
      groundingProvider: grounding.provider,
      storage: memoryStorage(),
      estimateCostUsd: () => 0,
    };

    await runGenerationStep(job.id, d);
    await runGenerationStep(job.id, d);

    // ONE search for the whole job…
    expect(grounding.calls).toHaveLength(1);
    // …and the generation calls never enable search themselves.
    expect(generationRequests).toHaveLength(2);
    expect(generationRequests.every((request) => request.plugins === undefined)).toBe(true);

    const stored = await getJob(job.id);
    expect(stored.sourcePool).not.toBeNull();
    expect(JSON.parse(stored.sourcePool!).extracts).toHaveLength(2);
    expect(stored.groundingCostUsd).toBeCloseTo(0.007, 6);

    // The pool travelled into the prompt as text.
    const second = await db()
      .select({ id: schema.aiGenerationBatches.id })
      .from(schema.aiGenerationBatches)
      .where(eq(schema.aiGenerationBatches.jobId, job.id));
    expect(second).toHaveLength(2);
  });

  it("runs ungrounded when the mode is off, and still completes", async () => {
    const job = await newJob(25, "off", `${TOPIC}Off`);
    const grounding = groundingStub();

    const d: GenerationDeps = {
      provider: stubProvider(() =>
        envelope(...Array.from({ length: 25 }, (_, i) => question(`Ungrounded probe q${i}?`))),
      ),
      groundingProvider: grounding.provider,
      storage: memoryStorage(),
    };

    const progress = await runGenerationStep(job.id, d);
    expect(progress.status).toBe("succeeded");
    expect(grounding.calls).toHaveLength(0);
    expect((await getJob(job.id)).sourcePool).toBeNull();
  });

  it("records a grounding failure and generates anyway", async () => {
    // A fresh topic, so this cannot be served from the cache the earlier test
    // populated — the failing provider really is called.
    const job = await newJob(25, "single", `${TOPIC}Fail`);
    const failing = {
      name: "failing",
      async generate() {
        throw new Error("search is down");
      },
    };

    const d: GenerationDeps = {
      provider: stubProvider(() =>
        envelope(...Array.from({ length: 25 }, (_, i) => question(`Grounded-fail probe q${i}?`))),
      ),
      groundingProvider: failing,
      storage: memoryStorage(),
    };

    const progress = await runGenerationStep(job.id, d);
    expect(progress.status).toBe("succeeded");
    expect(progress.groundingCostUsd).toBeNull();

    const stored = await getJob(job.id);
    expect(stored.sourcePool).toBeNull();
    expect(stored.groundingError).toMatch(/search is down/i);
  });
});
