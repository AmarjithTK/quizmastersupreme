/**
 * Dedupe layer 3 (M12).
 *
 * Embeddings and the vector index are injected, so the whole layer is exercised
 * with a deterministic local embedder and an in-memory index — no Workers AI
 * binding, no Vectorize account, no network.
 *
 * The embedder here is feature hashing, NOT a semantic model: it lands texts
 * together when they share vocabulary. That is enough to prove the plumbing,
 * the backfill and the disposability guarantee. Reaching the 0.85 default
 * threshold for a true paraphrase is what the real model is for.
 */

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { getPlatformProxy } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, setDbForTests } from "@/db/client";
import * as schema from "@/db/schema";
import {
  backfillEmbeddings,
  checkCandidate,
  cosineSimilarity,
  embeddingCoverage,
  featureHashEmbedder,
  findSemanticMatches,
  memoryVectorIndex,
  questionIdFromVectorId,
  vectorIdFor,
  type Embedder,
  type VectorIndex,
} from "@/modules/dedupe";
import { createQuestion, type QuestionDraft } from "@/modules/questions";

const ACTOR = "user__layer3_test";
const TOPIC = "DedupeLayer3Test";

let proxy: { env: { DB: D1Database }; dispose: () => Promise<void> } | null = null;

let embedder: Embedder;
let index: VectorIndex;

const STORY =
  "A sufficiently long backstory for the dedupe layer three tests, written as prose so the " +
  "validator accepts it without complaint.";

function draft(stem: string): QuestionDraft {
  return {
    stem,
    options: [
      { key: "A", body: "Zephyr" },
      { key: "B", body: "Quartz" },
      { key: "C", body: "Nimbus" },
      { key: "D", body: "Onyx" },
    ],
    correctOptionKey: "A",
    explanation: "Because Zephyr.",
    backstory: STORY,
    difficulty: "easy",
    topic: TOPIC,
    tags: ["layer3-test"],
  };
}

beforeAll(async () => {
  proxy = await getPlatformProxy<{ DB: D1Database }>({
    configPath: "wrangler.jsonc",
    persist: { path: ".tooling/test-state" },
  });
  setDbForTests(drizzle(proxy.env.DB, { schema }));

  embedder = featureHashEmbedder({ dimensions: 512 });
  index = memoryVectorIndex();

  await cleanup();
  await seed();
});

afterAll(async () => {
  await cleanup();
  await proxy?.dispose();
  proxy = null;
  setDbForTests(null);
});

async function cleanup(): Promise<void> {
  const rows = await db()
    .select({ id: schema.questions.id })
    .from(schema.questions)
    .where(eq(schema.questions.topic, TOPIC));
  for (const row of rows) {
    await db()
      .delete(schema.questionEmbeddings)
      .where(eq(schema.questionEmbeddings.questionId, row.id))
      .run();
  }
  await db().delete(schema.questions).where(eq(schema.questions.topic, TOPIC)).run();
}

async function seed() {
  await createQuestion(draft("Which ocean is the deepest on planet Earth?"), ACTOR, {
    status: "published",
  });
  await createQuestion(draft("Which gas do plants absorb during photosynthesis?"), ACTOR, {
    status: "published",
  });
  await createQuestion(draft("Who composed the nocturne in D minor for orchestra?"), ACTOR, {
    status: "published",
  });
}

// ── the pure pieces ──────────────────────────────────────────────────────────

describe("embeddings", () => {
  it("lands texts that share vocabulary close together", async () => {
    const [a, b, c] = await embedder.embed([
      "Which ocean is the deepest on planet Earth?",
      "Which ocean is the deepest on planet Earth",
      "Who composed the nocturne in D minor for orchestra?",
    ]);

    const near = cosineSimilarity(a!, b!);
    const far = cosineSimilarity(a!, c!);

    expect(near).toBeGreaterThan(0.95);
    expect(far).toBeLessThan(0.2);
    expect(near).toBeGreaterThan(far);
  });

  it("produces L2-normalised vectors of the requested size", async () => {
    const [vector] = await embedder.embed(["some text here"]);
    expect(vector).toHaveLength(512);
    const norm = Math.sqrt(vector!.reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it("is deterministic", async () => {
    const [a] = await embedder.embed(["stable text"]);
    const [b] = await embedder.embed(["stable text"]);
    expect(a).toEqual(b);
  });

  it("handles an empty input list", async () => {
    expect(await embedder.embed([])).toEqual([]);
  });

  it("cosineSimilarity is defensive about mismatched and empty vectors", () => {
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 6);
  });
});

describe("vector id round trip", () => {
  it("recovers the question id", () => {
    expect(questionIdFromVectorId(vectorIdFor("abc-123"))).toBe("abc-123");
  });
});

// ── the index ────────────────────────────────────────────────────────────────

describe("vector index", () => {
  it("filters by metadata rather than post-filtering a topK list", async () => {
    const local = memoryVectorIndex();
    const [published, draftVector] = await embedder.embed(["shared words here", "shared words here"]);

    await local.upsert([
      { id: vectorIdFor("q-published"), values: published!, metadata: { status: "published" } },
      { id: vectorIdFor("q-draft"), values: draftVector!, metadata: { status: "draft" } },
    ]);

    const matches = await local.query(published!, { topK: 5, filter: { status: "published" } });
    expect(matches.map((m) => m.id)).toEqual([vectorIdFor("q-published")]);
  });

  it("deletes by id and reports its size", async () => {
    const local = memoryVectorIndex();
    const [vector] = await embedder.embed(["x"]);
    await local.upsert([{ id: "a", values: vector! }, { id: "b", values: vector! }]);
    expect(await local.size()).toBe(2);

    await local.deleteByIds(["a"]);
    expect(await local.size()).toBe(1);
  });
});

// ── backfill ─────────────────────────────────────────────────────────────────

describe("backfillEmbeddings", () => {
  it("embeds published questions and records the metadata rows", async () => {
    const result = await backfillEmbeddings({ embedder, index }, { limit: 100 });

    expect(result.scanned).toBeGreaterThanOrEqual(3);
    expect(result.embedded).toBeGreaterThanOrEqual(3);
    expect(result.indexed).toBe(result.embedded);

    const coverage = await embeddingCoverage();
    expect(coverage.embedded).toBeGreaterThan(0);
  });

  it("skips questions whose embedded text has not changed", async () => {
    const second = await backfillEmbeddings({ embedder, index }, { limit: 100 });
    // Everything was embedded a moment ago and nothing changed.
    expect(second.embedded).toBe(0);
    expect(second.skipped).toBeGreaterThanOrEqual(3);
  });

  it("re-embeds when the question text changes", async () => {
    const { question } = await createQuestion(draft("A brand new layer three question?"), ACTOR, {
      status: "published",
    });

    const result = await backfillEmbeddings({ embedder, index }, { limit: 200 });
    expect(result.embedded).toBeGreaterThanOrEqual(1);

    await db()
      .delete(schema.questionEmbeddings)
      .where(eq(schema.questionEmbeddings.questionId, question.id))
      .run();

    const forced = await backfillEmbeddings({ embedder, index }, { limit: 200, force: true });
    expect(forced.embedded).toBeGreaterThanOrEqual(1);
  });
});

// ── finding semantic matches ─────────────────────────────────────────────────

describe("findSemanticMatches", () => {
  it("finds an indexed question from its exact text", async () => {
    const matches = await findSemanticMatches({
      stem: "Which ocean is the deepest on planet Earth?",
      optionBodies: ["Zephyr", "Quartz", "Nimbus", "Onyx"],
      semantic: { embedder, index },
      threshold: 0.8,
    });

    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]!.score).toBeGreaterThan(0.8);
  });

  it("does not match an unrelated question", async () => {
    const matches = await findSemanticMatches({
      stem: "What is the melting point of tungsten carbide?",
      optionBodies: ["Zephyr", "Quartz", "Nimbus", "Onyx"],
      semantic: { embedder, index },
      threshold: 0.5,
    });

    expect(matches).toHaveLength(0);
  });

  it("excludes the question being edited", async () => {
    const rows = await db()
      .select({ id: schema.questions.id })
      .from(schema.questions)
      .where(eq(schema.questions.topic, TOPIC));

    const matches = await findSemanticMatches({
      stem: "Which ocean is the deepest on planet Earth?",
      optionBodies: [],
      semantic: { embedder, index },
      threshold: 0.3,
      excludeQuestionId: rows[0]!.id,
    });

    expect(matches.map((m) => m.questionId)).not.toContain(rows[0]!.id);
  });
});

// ── §2.3 — the index is disposable ───────────────────────────────────────────

describe("§2.3 D1 is the source of truth; the index is disposable", () => {
  it("drop the index, rebuild it from D1 alone, and layer 3 works again", async () => {
    const stem = "Which ocean is the deepest on planet Earth?";
    const optionBodies = ["Zephyr", "Quartz", "Nimbus", "Onyx"];

    // 1. Working index.
    await backfillEmbeddings({ embedder, index }, { limit: 200, force: true });
    const before = await findSemanticMatches({
      stem,
      optionBodies,
      semantic: { embedder, index },
      threshold: 0.8,
    });
    expect(before.length).toBeGreaterThan(0);

    // 2. Destroy it — simulating a deleted or recreated Vectorize index.
    const rebuilt = memoryVectorIndex();
    const whileEmpty = await findSemanticMatches({
      stem,
      optionBodies,
      semantic: { embedder, index: rebuilt },
      threshold: 0.8,
    });
    expect(whileEmpty).toHaveLength(0);
    expect(await rebuilt.size()).toBe(0);

    // 3. Rebuild from D1 ONLY — no external state, no export, no backup.
    const result = await backfillEmbeddings({ embedder, index: rebuilt }, { limit: 200, force: true });
    expect(result.embedded).toBeGreaterThan(0);

    const after = await findSemanticMatches({
      stem,
      optionBodies,
      semantic: { embedder, index: rebuilt },
      threshold: 0.8,
    });
    expect(after.length).toBe(before.length);
    expect(after[0]!.questionId).toBe(before[0]!.questionId);
  });
});

// ── the funnel ───────────────────────────────────────────────────────────────

describe("layer 3 in the funnel", () => {
  it("flags a semantic duplicate WITHOUT auto-rejecting it", async () => {
    // This test isolates the WIRING, not the model. A feature-hash embedder is
    // lexical, so it cannot demonstrate that a true paraphrase lands close —
    // only the real model can, and that needs a Workers AI binding. What is
    // verified here is that a high cosine score produces a semantic flag that
    // does not auto-reject.
    //
    // The text deliberately shares almost no vocabulary with the indexed
    // question, so layers 1 and 2 both miss it and layer 3 is what fires.
    const alwaysSimilar: Embedder = {
      model: "test-always-similar",
      dimensions: 2,
      async embed(texts) {
        return texts.map(() => [1, 0]);
      },
    };

    // Its own index, populated with a vector of the SAME width — comparing a
    // 2-dim query against 512-dim stored vectors would score essentially at
    // random, which is a mistake in the test rather than in the layer.
    const localIndex = memoryVectorIndex();
    await localIndex.upsert([
      {
        id: vectorIdFor("q_semantic_probe"),
        values: [1, 0],
        metadata: { status: "published", questionId: "q_semantic_probe" },
      },
    ]);

    const verdict = await checkCandidate(
      {
        stem: "What body of water reaches the greatest depth on this world?",
        optionBodies: ["Zephyr", "Quartz", "Nimbus", "Onyx"],
      },
      { semantic: { embedder: alwaysSimilar, index: localIndex } },
    );

    expect(verdict.layer).toBe("semantic");
    expect(verdict.status).toBe("semantic_dup");
    // Evidence, never a verdict (§13.6).
    expect(verdict.autoReject).toBe(false);
    expect(verdict.degraded).toEqual([]);
  });

  it("does NOT flag when the semantic score is below the review threshold", async () => {
    const neverSimilar: Embedder = {
      model: "test-never-similar",
      dimensions: 2,
      async embed(texts) {
        // Orthogonal to any indexed vector.
        return texts.map(() => [0, 1]);
      },
    };

    const localIndex = memoryVectorIndex();
    await localIndex.upsert([
      {
        id: vectorIdFor("q_semantic_probe"),
        values: [1, 0],
        metadata: { status: "published", questionId: "q_semantic_probe" },
      },
    ]);

    const verdict = await checkCandidate(
      {
        stem: "What body of water reaches the greatest depth on this world?",
        optionBodies: ["Zephyr", "Quartz", "Nimbus", "Onyx"],
      },
      { semantic: { embedder: neverSimilar, index: localIndex } },
    );

    expect(verdict.layer).toBeNull();
    expect(verdict.degraded).toEqual([]);
  });

  it("reports layer 3 as DEGRADED when no semantic pair is supplied", async () => {
    const verdict = await checkCandidate({
      stem: "A question that only layers one and two will see?",
      optionBodies: ["Zephyr"],
    });

    expect(verdict.status).toBe("clean");
    // Never claim a question was checked three times when it was checked twice.
    expect(verdict.degraded).toContain("semantic");
  });
});
