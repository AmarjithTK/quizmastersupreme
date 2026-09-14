/**
 * Coverage-aware generation (M13) against real D1 + FTS5.
 *
 * The mechanism exists because an LLM call is stateless: without a compressed
 * view of what the bank already asks, it re-asks the same facts every time.
 * What is verified here is that the compression is relevant (bm25-ranked, not
 * an arbitrary slice), bounded, and actually reaches the prompt.
 */

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { getPlatformProxy } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, setDbForTests } from "@/db/client";
import * as schema from "@/db/schema";
import { buildCoverageDigest, createGenerationJob, extractConceptKey, estimateTokens } from "@/modules/ai";
import { buildUserPrompt, PROMPT_VERSION } from "@/modules/ai";
import { createQuestion, type QuestionDraft } from "@/modules/questions";

const ACTOR = "user__coverage_test";
const TOPIC = "CoverageDigestTest";
/** Filed elsewhere, but sharing vocabulary with TOPIC — the precision trap. */
const NOISE_TOPIC = "CoverageDigestNoise";

let proxy: { env: { DB: D1Database }; dispose: () => Promise<void> } | null = null;

const STORY =
  "A sufficiently long backstory for the coverage digest tests, written as prose so the " +
  "validator accepts it without complaint.";

function draft(stem: string, answer: string, topic = TOPIC): QuestionDraft {
  return {
    stem,
    options: [
      { key: "A", body: answer },
      { key: "B", body: "Quartz" },
      { key: "C", body: "Nimbus" },
      { key: "D", body: "Onyx" },
    ],
    correctOptionKey: "A",
    explanation: "Because that is the answer.",
    backstory: STORY,
    difficulty: "easy",
    topic,
    tags: ["coverage-test"],
  };
}

beforeAll(async () => {
  proxy = await getPlatformProxy<{ DB: D1Database }>({
    configPath: "wrangler.jsonc",
    persist: { path: ".tooling/test-state" },
  });
  setDbForTests(drizzle(proxy.env.DB, { schema }));
  await cleanup();

  // A dozen questions on the topic, each with a distinct fact.
  const facts: Array<[string, string]> = [
    ["Who created the Linux kernel?", "Linus Torvalds"],
    ["In which year was the Linux kernel first released?", "1991"],
    ["What is the name of the Linux mascot?", "Tux"],
    ["Which licence was the Linux kernel released under?", "GPLv2"],
    ["Which company created the Ubuntu distribution?", "Canonical"],
    ["Which distribution is Ubuntu based on?", "Debian"],
    ["Who founded the Debian project?", "Ian Murdock"],
    ["Which init system replaced SysVinit on most distributions?", "systemd"],
    ["Who created the systemd init system?", "Lennart Poettering"],
    ["Which company acquired Red Hat?", "IBM"],
    ["In which year did IBM acquire Red Hat?", "2019"],
    ["What does POSIX standardise?", "Operating system interfaces"],
  ];

  for (const [stem, answer] of facts) {
    await createQuestion(draft(stem, answer), ACTOR, { status: "active" });
  }

  // Two decoys. Each shares ONE word with the queries below, which is exactly
  // what an OR-only retrieval would treat as a match.
  await createQuestion(
    draft("Who wrote the Minix kernel?", "Andrew Tanenbaum", NOISE_TOPIC),
    ACTOR,
    { status: "active" },
  );
  await createQuestion(
    draft("Which company maintains Linux Mint?", "Clem Lefebvre", NOISE_TOPIC),
    ACTOR,
    { status: "active" },
  );
});

afterAll(async () => {
  await cleanup();
  await proxy?.dispose();
  proxy = null;
  setDbForTests(null);
});

async function cleanup(): Promise<void> {
  for (const topic of [TOPIC, NOISE_TOPIC]) {
    await db().delete(schema.questions).where(eq(schema.questions.topic, topic)).run();
  }
  const jobs = await db().select({ id: schema.aiGenerationJobs.id }).from(schema.aiGenerationJobs);
  for (const job of jobs) {
    await db().delete(schema.aiCandidates).where(eq(schema.aiCandidates.jobId, job.id)).run();
    await db().delete(schema.aiGenerationJobs).where(eq(schema.aiGenerationJobs.id, job.id)).run();
  }
}

// ── concept keys ─────────────────────────────────────────────────────────────

describe("extractConceptKey", () => {
  it("strips the interrogative and keeps the subject plus the answer", () => {
    expect(extractConceptKey("Who created the Linux kernel?", "Linus Torvalds")).toBe(
      "created the linux kernel → Linus Torvalds",
    );
  });

  it("handles multi-word interrogatives", () => {
    const key = extractConceptKey("In which year was the Linux kernel first released?", "1991");
    expect(key).toContain("1991");
    expect(key.startsWith("in which year")).toBe(false);
  });

  it("truncates a very long subject", () => {
    const key = extractConceptKey(
      "Which of the following statements about the internal architecture of the Linux kernel is correct?",
      "Monolithic",
    );
    const subject = key.split(" → ")[0]!;
    expect(subject.split(" ").length).toBeLessThanOrEqual(9);
  });

  it("returns empty for an empty stem", () => {
    expect(extractConceptKey("", null)).toBe("");
  });
});

// ── the digest ───────────────────────────────────────────────────────────────

describe("buildCoverageDigest", () => {
  it("finds the questions already covering a topic", async () => {
    const digest = await buildCoverageDigest({ topic: TOPIC });

    expect(digest.questionCount).toBeGreaterThanOrEqual(10);
    expect(digest.conceptCount).toBeGreaterThanOrEqual(10);
    expect(digest.text).toContain("ALREADY COVERED");
    expect(digest.text).toContain("Linus Torvalds");
    expect(digest.estimatedTokens).toBeGreaterThan(0);
  });

  it("phrases the block as an instruction, not just a list", async () => {
    const digest = await buildCoverageDigest({ topic: TOPIC });
    expect(digest.text).toMatch(/do not create questions testing these facts/i);
  });

  it("respects the token budget and says when it truncated", async () => {
    const tiny = await buildCoverageDigest({ topic: TOPIC, maxTokens: 120 });

    expect(tiny.truncated).toBe(true);
    // The block stays near the budget rather than blowing through it.
    expect(tiny.estimatedTokens).toBeLessThanOrEqual(260);
    expect(tiny.text).toContain("more already-covered concepts");
  });

  it("reports the full concept count even when the block is truncated", async () => {
    const tiny = await buildCoverageDigest({ topic: TOPIC, maxTokens: 150 });
    const full = await buildCoverageDigest({ topic: TOPIC });

    expect(tiny.conceptCount).toBe(full.conceptCount);
    expect(tiny.estimatedTokens).toBeLessThan(full.estimatedTokens);
  });

  it("returns an empty block for a topic the bank knows nothing about", async () => {
    const digest = await buildCoverageDigest({ topic: "NothingAtAllLikeThis12345" });
    expect(digest.conceptCount).toBe(0);
    expect(digest.text).toBe("");
  });

  it("deduplicates near-identical concepts", async () => {
    // A second question with the same subject+answer must not add a line.
    await createQuestion(draft("Who created the Linux kernel?", "Linus Torvalds"), ACTOR, {
      status: "active",
    }).catch(() => undefined);

    const digest = await buildCoverageDigest({ topic: TOPIC });
    const torvaldsLines = digest.text
      .split("\n")
      .filter((line) => line.includes("Linus Torvalds"));
    expect(torvaldsLines.length).toBeLessThanOrEqual(1);
  });

  it("can include full example stems on request", async () => {
    const withExamples = await buildCoverageDigest({ topic: TOPIC, includeExamples: true });
    expect(withExamples.text).toContain("EXAMPLES OF EXISTING QUESTIONS");
  });

  it("finds questions that share vocabulary but are filed under another topic", async () => {
    const digest = await buildCoverageDigest({ topic: "kernel" });
    expect(digest.questionCount).toBeGreaterThan(0);
  });

  /**
   * The topic tag is the precise signal; full text is the guess. When the tag
   * alone already answers the question, the guess must not run at all — an
   * OR-based FTS pass over a topic NAME pulls in every question that happens to
   * share one common word.
   */
  it("trusts the topic tag and skips the full-text top-up when it is enough", async () => {
    const digest = await buildCoverageDigest({ topic: TOPIC });

    expect(digest.questionCount).toBe(12);
    expect(digest.text).not.toContain("Minix");
    expect(digest.text).not.toContain("Linux Mint");
  });

  /**
   * When the top-up does run it is conjunctive: every term must appear. The
   * decoy about the Minix kernel shares "kernel" with the query but nothing
   * else, so it is not evidence that the bank covers "CoverageDigestTest
   * kernel" — and under OR-only retrieval it would have been.
   */
  it("requires every term to match when topping up from full text", async () => {
    const digest = await buildCoverageDigest({ topic: `${TOPIC} kernel` });

    expect(digest.questionCount).toBe(3);
    expect(digest.text).toContain("Linus Torvalds");
    expect(digest.text).not.toContain("Minix");
  });
});

// ── the prompt ───────────────────────────────────────────────────────────────

describe("the digest reaches the prompt", () => {
  it("is included in the user prompt when present", () => {
    const prompt = buildUserPrompt({
      topic: TOPIC,
      count: 10,
      brief: "Write questions.",
      coverageDigest: "ALREADY COVERED — X\n- something → answer",
    });

    expect(prompt).toContain("ALREADY COVERED");
    expect(prompt).toContain("do NOT test these facts");
    expect(prompt).toContain("something → answer");
  });

  it("is omitted entirely when there is no coverage", () => {
    const prompt = buildUserPrompt({
      topic: TOPIC,
      count: 10,
      brief: "Write questions.",
      coverageDigest: null,
    });

    expect(prompt).not.toContain("ALREADY COVERED");
  });
});

// ── persistence ──────────────────────────────────────────────────────────────

describe("jobs persist their digest", () => {
  it("records the digest and its token cost on the job row", async () => {
    const job = await createGenerationJob(
      { topic: TOPIC, brief: "Coverage test.", requestedCount: 5, model: "stub/model" },
      ACTOR,
    );

    expect(job.coverageDigest).toBeTruthy();
    expect(job.coverageDigest).toContain("ALREADY COVERED");
    // Cost is attributable after the fact because the digest is stored.
    expect(job.coverageTokens).toBeGreaterThan(0);
    expect(job.promptVersion).toBe(PROMPT_VERSION);
  });

  it("stores no digest for a topic with no existing coverage", async () => {
    const job = await createGenerationJob(
      {
        topic: "ATopicWithNoQuestionsAtAll98765",
        brief: "Coverage test.",
        requestedCount: 5,
        model: "stub/model",
      },
      ACTOR,
    );

    expect(job.coverageDigest).toBeNull();
    expect(job.coverageTokens).toBe(0);
  });
});

describe("estimateTokens", () => {
  it("scales with length", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });
});
