/**
 * Dedupe layer 2 (M11) against real D1 + real FTS5.
 *
 * The property that matters most is a NEGATIVE one: layer 2 must never
 * auto-reject. "Who created Linux?" and "In which year was Linux released?" are
 * both good questions, and similarity is not identity (PLAN.md §13.6).
 */

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { getPlatformProxy } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, setDbForTests } from "@/db/client";
import * as schema from "@/db/schema";
import {
  checkCandidate,
  checkCandidates,
  classifyTextSimilarity,
  contentWords,
  findTextDuplicates,
  isAutoFiltered,
  jaccard,
} from "@/modules/dedupe";
import { createQuestion, type QuestionDraft } from "@/modules/questions";

const ACTOR = "user__dedupe_test";
const TOPIC = "DedupeLayer2Test";

let proxy: { env: { DB: D1Database }; dispose: () => Promise<void> } | null = null;

const STORY =
  "A sufficiently long backstory for the dedupe layer two tests, written as prose so the " +
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
    tags: ["dedupe-test"],
  };
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
  await db().delete(schema.questions).where(eq(schema.questions.topic, TOPIC)).run();
}

// ── the pure pieces ──────────────────────────────────────────────────────────

describe("contentWords and jaccard", () => {
  it("drops stopwords and very short words", () => {
    const words = contentWords("What is the capital of Kerala?");
    expect(words).toContain("capital");
    expect(words).toContain("kerala");
    expect(words).not.toContain("the");
    expect(words).not.toContain("of");
    expect(words).not.toContain("is");
  });

  it("scores identical word sets as 1 and disjoint sets as 0", () => {
    expect(jaccard(["a", "b"], ["b", "a"])).toBe(1);
    expect(jaccard(["a", "b"], ["c", "d"])).toBe(0);
    expect(jaccard([], ["a"])).toBe(0);
  });

  it("scores a partial overlap in between", () => {
    // {linux, kernel} shared out of {linux, kernel, created, author, wrote}
    const score = jaccard(["linux", "kernel", "created"], ["linux", "kernel", "author", "wrote"]);
    expect(score).toBeGreaterThan(0.3);
    expect(score).toBeLessThan(0.7);
  });
});

describe("classifyTextSimilarity", () => {
  it("maps scores onto the configured bands", () => {
    const thresholds = { reject: 0.85, review: 0.65 };
    expect(classifyTextSimilarity(0.95, thresholds)).toBe("near_dup");
    expect(classifyTextSimilarity(0.85, thresholds)).toBe("near_dup");
    expect(classifyTextSimilarity(0.7, thresholds)).toBe("possible_dup");
    expect(classifyTextSimilarity(0.3, thresholds)).toBe("clean");
  });
});

// ── finding similar questions ────────────────────────────────────────────────

describe("findTextDuplicates", () => {
  it("finds a near-identical question already in the bank", async () => {
    const stem = "Which planet is the largest in the Solar System?";
    await createQuestion(draft(stem), ACTOR, { status: "active" });

    const { best } = await findTextDuplicates({
      stem: "Which planet is largest in the Solar System?",
      threshold: 0.5,
    });

    expect(best).toBeTruthy();
    expect(best!.stem).toContain("largest in the Solar System");
    expect(best!.similarity).toBeGreaterThan(0.7);
  });

  it("does not match an unrelated question", async () => {
    await createQuestion(draft("Who composed the M9 dedupe unrelated symphony?"), ACTOR, {
      status: "active",
    });

    const { best } = await findTextDuplicates({
      stem: "What is the atomic number of tungsten?",
      threshold: 0.5,
    });
    expect(best).toBeNull();
  });

  it("excludes the question being edited from its own matches", async () => {
    const { question } = await createQuestion(
      draft("Which river is the longest in Kerala state?"),
      ACTOR,
      { status: "active" },
    );

    const { matches } = await findTextDuplicates({
      stem: "Which river is the longest in Kerala state?",
      excludeQuestionId: question.id,
      threshold: 0.5,
    });

    expect(matches.map((m) => m.questionId)).not.toContain(question.id);
  });

  it("does not blow up on FTS syntax characters", async () => {
    await expect(
      findTextDuplicates({ stem: 'weird "quotes" and *stars* (parens)' }),
    ).resolves.toBeTruthy();
  });
});

// ── the funnel ───────────────────────────────────────────────────────────────

describe("checkCandidate with layer 2 active", () => {
  it("auto-rejects an EXACT duplicate at layer 1", async () => {
    await createQuestion(draft("Which metal has the symbol Au?"), ACTOR, { status: "active" });

    const verdict = await checkCandidate({
      stem: "WHICH METAL HAS THE SYMBOL AU",
      optionBodies: ["Zephyr", "Quartz", "Nimbus", "Onyx"],
    });

    expect(verdict.status).toBe("exact_dup");
    expect(verdict.layer).toBe("exact");
    expect(verdict.autoReject).toBe(true);
  });

  it("classifies a reworded question at layer 2 by similarity band", async () => {
    await createQuestion(draft("Which gas do plants absorb during photosynthesis?"), ACTOR, {
      status: "active",
    });

    const verdict = await checkCandidate({
      stem: "Which gas do plants absorb during the process of photosynthesis?",
      optionBodies: ["Zephyr", "Quartz", "Nimbus", "Onyx"],
    });

    // Two bands: >= jaccardReject is auto-filtered; the review band only flags.
    expect(verdict.layer).toBe("text");
    expect(["near_dup", "possible_dup"]).toContain(verdict.status);
    expect(verdict.autoReject).toBe(verdict.status === "near_dup");
    expect(isAutoFiltered(verdict)).toBe(verdict.status === "near_dup");
    expect(verdict.bestMatch).toBeTruthy();
  });

  it("reports a genuinely different question as clean", async () => {
    const verdict = await checkCandidate({
      stem: "Who invented the M11 zephyrscope instrument?",
      optionBodies: ["Zephyr", "Quartz", "Nimbus", "Onyx"],
    });

    expect(verdict.status).toBe("clean");
    expect(verdict.autoReject).toBe(false);
    expect(isAutoFiltered(verdict)).toBe(false);
  });

  it("stops flagging a merely same-topic question as a duplicate", async () => {
    await createQuestion(draft("Who created the Linux kernel?"), ACTOR, { status: "active" });

    const verdict = await checkCandidate({
      stem: "In which year was the Linux kernel first released?",
      optionBodies: ["Zephyr", "Quartz", "Nimbus", "Onyx"],
    });

    // Overlap exists — this is the case a naive dedupe would wrongly destroy.
    expect(verdict.autoReject).toBe(false);
  });

  it("handles a whole batch and returns one verdict per draft, in order", async () => {
    const verdicts = await checkCandidates([
      { stem: "Which metal has the symbol Au?", optionBodies: ["a"] },
      { stem: "Who invented the M11 batchprobe instrument?", optionBodies: ["a"] },
    ]);

    expect(verdicts).toHaveLength(2);
    expect(verdicts[0]!.status).toBe("exact_dup");
    expect(verdicts[1]!.status).toBe("clean");
  });

  it("returns an empty array for an empty batch", async () => {
    expect(await checkCandidates([])).toEqual([]);
  });
});
