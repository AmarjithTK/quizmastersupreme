/**
 * Quiz engine invariants (M5) against real D1.
 *
 * These are the plan's §18.2 tests #1–#6 — the ones that protect the rules the
 * whole product rests on: answer secrecy, resume, idempotency, one active
 * attempt, a server-owned clock, and server-computed scoring.
 *
 * The answer-secrecy test asserts on the SERIALIZED payload, not the type: a
 * TypeScript type would not stop a leak, only the response shape will.
 */

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { getPlatformProxy } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, setDbForTests } from "@/db/client";
import * as schema from "@/db/schema";
import { createQuestion } from "@/modules/questions";
import {
  abandonAttempt,
  completeAttempt,
  getAnswerReveal,
  getAttemptQuestions,
  getAttemptState,
  getAttemptSummary,
  startOrResumeAttempt,
  submitAnswer,
} from "@/modules/quiz";

const ACTOR = "user__quiz_test";
const CATEGORY = "cat__quiz_test";
const SET = "set__quiz_test";
const SET_SHORT_TIMER = "set__quiz_timer_test";

let proxy: { env: { DB: D1Database }; dispose: () => Promise<void> } | null = null;
let questionIds: string[] = [];

const STORY =
  "A deliberately long backstory for the quiz engine tests, long enough to satisfy the " +
  "validation minimum and containing real prose rather than filler.";

function draft(stem: string, correct: "A" | "B" | "C" | "D" = "A") {
  return {
    stem,
    // Option bodies deliberately share no words with the stems above, so the
    // "stem gives away the answer" validator does not fire on the fixtures.
    options: [
      { key: "A" as const, body: "Zephyr" },
      { key: "B" as const, body: "Quartz" },
      { key: "C" as const, body: "Nimbus" },
      { key: "D" as const, body: "Onyx" },
    ],
    correctOptionKey: correct,
    explanation: "Because Zephyr is the intended answer.",
    backstory: `${STORY}\n\n| Col | Val |\n|-----|-----|\n| a | 1 |\n\n> A blockquote.`,
    difficulty: "easy" as const,
    topic: "QuizTest",
    tags: ["quiz-test"],
  };
}

beforeAll(async () => {
  proxy = await getPlatformProxy<{ DB: D1Database }>({
    configPath: "wrangler.jsonc",
    persist: { path: ".tooling/test-state" },
  });
  setDbForTests(drizzle(proxy.env.DB, { schema }));

  await cleanup();

  const now = Date.now();
  await db()
    .insert(schema.categories)
    .values({
      id: CATEGORY,
      slug: "quiz-test",
      title: "Quiz Test",
      sortOrder: 0,
      status: "published",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();

  await db()
    .insert(schema.quizSets)
    .values([
      {
        id: SET,
        categoryId: CATEGORY,
        slug: "quiz-test-set",
        title: "Quiz Test Set",
        mode: "practice",
        difficulty: "easy",
        // Shuffle OFF so the order is deterministic for assertions.
        shuffleQuestions: 0,
        shuffleOptions: 0,
        sortOrder: 0,
        status: "published",
        publishedAt: now,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: SET_SHORT_TIMER,
        categoryId: CATEGORY,
        slug: "quiz-timer-set",
        title: "Quiz Timer Set",
        mode: "mock",
        difficulty: "easy",
        timeLimitSeconds: 60,
        shuffleQuestions: 0,
        shuffleOptions: 0,
        sortOrder: 1,
        status: "published",
        publishedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    ])
    .onConflictDoNothing();

  // Four published questions, attached in order.
  for (const [index, stem] of [
    "Quiz test question alpha?",
    "Quiz test question bravo?",
    "Quiz test question charlie?",
    "Quiz test question delta?",
  ].entries()) {
    const { question } = await createQuestion(draft(stem), ACTOR, { status: "published" });
    questionIds.push(question.id);
    await db()
      .insert(schema.questionSetQuestions)
      .values({ setId: SET, questionId: question.id, sortOrder: index, addedAt: now })
      .onConflictDoNothing();
    await db()
      .insert(schema.questionSetQuestions)
      .values({ setId: SET_SHORT_TIMER, questionId: question.id, sortOrder: index, addedAt: now })
      .onConflictDoNothing();
  }
});

afterAll(async () => {
  await cleanup();
  await proxy?.dispose();
  proxy = null;
  setDbForTests(null);
});

async function cleanup(): Promise<void> {
  for (const setId of [SET, SET_SHORT_TIMER]) {
    await db().delete(schema.quizAttempts).where(eq(schema.quizAttempts.setId, setId)).run();
    await db().delete(schema.questionSetQuestions).where(eq(schema.questionSetQuestions.setId, setId)).run();
  }
  await db().delete(schema.quizSets).where(eq(schema.quizSets.categoryId, CATEGORY)).run();
  await db().delete(schema.categories).where(eq(schema.categories.id, CATEGORY)).run();
  await db().delete(schema.categories).where(eq(schema.categories.slug, "quiz-test")).run();
  await db().delete(schema.userQuestionSeen).where(eq(schema.userQuestionSeen.userId, ACTOR)).run();
  await db().delete(schema.userSetStats).where(eq(schema.userSetStats.userId, ACTOR)).run();
}

/** Each test gets its own user, so the one-active-attempt index never leaks between tests. */
function user(name: string) {
  return `user__quiz_${name}`;
}

async function finishAll(userId: string) {
  const rows = await db().select().from(schema.quizAttempts).where(eq(schema.quizAttempts.userId, userId));
  for (const row of rows) {
    await db()
      .update(schema.quizAttempts)
      .set({ status: "abandoned" })
      .where(eq(schema.quizAttempts.id, row.id))
      .run();
  }
}

// ── §11.3 / §11.4 ────────────────────────────────────────────────────────────

describe("start and resume", () => {
  it("creates an attempt with a frozen question order", async () => {
    const u = user("start");
    await finishAll(u);

    const { attempt, resumed } = await startOrResumeAttempt(u, SET);
    expect(resumed).toBe(false);
    expect(attempt.status).toBe("in_progress");
    expect(attempt.totalQuestions).toBe(4);
    expect(JSON.parse(attempt.questionOrder)).toEqual(questionIds);
  });

  it("RESUMES the same attempt on a second start, creating no new row", async () => {
    const u = user("resume");
    await finishAll(u);

    const first = await startOrResumeAttempt(u, SET);
    const second = await startOrResumeAttempt(u, SET);

    expect(second.resumed).toBe(true);
    expect(second.attempt.id).toBe(first.attempt.id);

    const rows = await db().select().from(schema.quizAttempts).where(eq(schema.quizAttempts.userId, u));
    expect(rows).toHaveLength(1);
  });

  it("refuses to start a set that has no published questions", async () => {
    const u = user("empty");
    const now = Date.now();
    await db()
      .insert(schema.quizSets)
      .values({
        id: "set__quiz_empty",
        categoryId: CATEGORY,
        slug: "quiz-empty-set",
        title: "Empty",
        mode: "practice",
        difficulty: "easy",
        shuffleQuestions: 0,
        shuffleOptions: 0,
        sortOrder: 9,
        status: "published",
        publishedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();

    await expect(startOrResumeAttempt(u, "set__quiz_empty")).rejects.toMatchObject({
      code: "CONFLICT",
    });

    await db().delete(schema.quizSets).where(eq(schema.quizSets.id, "set__quiz_empty")).run();
  });
});

// ── §2.6 — answer secrecy ────────────────────────────────────────────────────

describe("§2.6 answer secrecy", () => {
  it("NEVER sends correctness, explanation or backstory before an answer", async () => {
    const u = user("secrecy");
    await finishAll(u);
    const { attempt } = await startOrResumeAttempt(u, SET);

    const questions = await getAttemptQuestions(attempt.id, u, 0, 4);
    expect(questions).toHaveLength(4);

    // Assert on the SERIALIZED payload — a type would not stop a leak.
    const serialized = JSON.stringify(questions);

    expect(serialized).not.toContain("isCorrect");
    expect(serialized).not.toContain("is_correct");
    expect(serialized).not.toContain("correctOptionKey");
    expect(serialized).not.toContain("backstory");
    expect(serialized).not.toContain("explanation");
    expect(serialized).not.toContain("A deliberately long backstory");

    // And the shape is exactly what the runner needs.
    const first = questions[0]!;
    expect(Object.keys(first).sort()).toEqual(
      ["answered", "difficulty", "index", "options", "questionId", "stem", "stemFormat", "topic"].sort(),
    );
    expect(first.options).toHaveLength(4);
  });

  it("refuses to reveal a question that has not been answered", async () => {
    const u = user("noreveal");
    await finishAll(u);
    const { attempt } = await startOrResumeAttempt(u, SET);

    await expect(getAnswerReveal(attempt.id, u, questionIds[0]!)).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("reveals only AFTER an answer, and only for that question", async () => {
    const u = user("reveal");
    await finishAll(u);
    const { attempt } = await startOrResumeAttempt(u, SET);

    const result = await submitAnswer(attempt.id, u, {
      questionId: questionIds[0]!,
      selectedOptionKey: "A",
    });

    expect(result.isCorrect).toBe(true);
    expect(result.correctOptionKey).toBe("A");
    expect(result.backstory).toContain("A deliberately long backstory");

    // The NEXT question is still sealed.
    await expect(getAnswerReveal(attempt.id, u, questionIds[1]!)).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });
});

// ── §2.5 — idempotency ───────────────────────────────────────────────────────

describe("§2.5 idempotent answers", () => {
  it("updates rather than duplicating when the same answer is submitted twice", async () => {
    const u = user("idem");
    await finishAll(u);
    const { attempt } = await startOrResumeAttempt(u, SET);

    // First submission: wrong. Second (double-click / retry): right.
    await submitAnswer(attempt.id, u, { questionId: questionIds[0]!, selectedOptionKey: "B" });
    const second = await submitAnswer(attempt.id, u, {
      questionId: questionIds[0]!,
      selectedOptionKey: "A",
    });

    const rows = await db()
      .select()
      .from(schema.quizAttemptAnswers)
      .where(eq(schema.quizAttemptAnswers.attemptId, attempt.id));

    expect(rows).toHaveLength(1);
    expect(rows[0]!.selectedOptionKey).toBe("A");
    expect(second.isCorrect).toBe(true);
  });

  it("rejects an option that does not belong to the question", async () => {
    const u = user("badopt");
    await finishAll(u);
    const { attempt } = await startOrResumeAttempt(u, SET);

    await expect(
      submitAnswer(attempt.id, u, { questionId: questionIds[0]!, selectedOptionKey: "E" }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("rejects a question that is not part of the attempt", async () => {
    const u = user("foreignq");
    await finishAll(u);
    const { attempt } = await startOrResumeAttempt(u, SET);

    await expect(
      submitAnswer(attempt.id, u, { questionId: "q__not_in_this_paper", selectedOptionKey: "A" }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

// ── §16.2 — ownership ────────────────────────────────────────────────────────

describe("ownership", () => {
  it("refuses to read another user's attempt", async () => {
    const owner = user("owner");
    const other = user("intruder");
    await finishAll(owner);
    const { attempt } = await startOrResumeAttempt(owner, SET);

    await expect(getAttemptState(attempt.id, other)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      submitAnswer(attempt.id, other, { questionId: questionIds[0]!, selectedOptionKey: "A" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

// ── §11.5 / §11.6 — clock and scoring ────────────────────────────────────────

describe("§11.5 server-authoritative clock", () => {
  it("rejects an answer submitted after the deadline plus grace", async () => {
    const u = user("late");
    await finishAll(u);
    const { attempt } = await startOrResumeAttempt(u, SET_SHORT_TIMER);

    // Move the server deadline into the past, as if the clock had run out.
    await db()
      .update(schema.quizAttempts)
      .set({ serverDeadlineAt: Date.now() - 60_000 })
      .where(eq(schema.quizAttempts.id, attempt.id))
      .run();

    await expect(
      submitAnswer(attempt.id, u, { questionId: questionIds[0]!, selectedOptionKey: "A" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("marks a timed-out attempt expired and scores it rather than leaving it open", async () => {
    const u = user("expire");
    await finishAll(u);
    const { attempt } = await startOrResumeAttempt(u, SET_SHORT_TIMER);

    await db()
      .update(schema.quizAttempts)
      .set({ serverDeadlineAt: Date.now() - 60_000 })
      .where(eq(schema.quizAttempts.id, attempt.id))
      .run();

    const state = await getAttemptState(attempt.id, u);
    expect(state.status).toBe("expired");
  });

  it("leaves an untimed attempt without a deadline", async () => {
    const u = user("untimed");
    await finishAll(u);
    const { attempt } = await startOrResumeAttempt(u, SET);

    const state = await getAttemptState(attempt.id, u);
    expect(state.serverDeadlineAt).toBeNull();
    expect(state.remainingSeconds).toBeNull();
  });
});

describe("§11.6 server-side scoring", () => {
  it("counts unanswered questions against the candidate", async () => {
    const u = user("score");
    await finishAll(u);
    const { attempt } = await startOrResumeAttempt(u, SET);

    // Two right, one wrong, one left blank.
    await submitAnswer(attempt.id, u, { questionId: questionIds[0]!, selectedOptionKey: "A" });
    await submitAnswer(attempt.id, u, { questionId: questionIds[1]!, selectedOptionKey: "A" });
    await submitAnswer(attempt.id, u, { questionId: questionIds[2]!, selectedOptionKey: "D" });

    await completeAttempt(attempt.id, u);
    const summary = await getAttemptSummary(attempt.id, u);

    expect(summary.status).toBe("completed");
    expect(summary.score.correct).toBe(2);
    expect(summary.score.wrong).toBe(1);
    expect(summary.score.skipped).toBe(1);
    // 2/4 = 50%, NOT 2/3 — blanks count against you.
    expect(summary.score.percent).toBe(50);
  });

  it("ignores any client-supplied score (there is no field for one)", async () => {
    const u = user("clientScore");
    await finishAll(u);
    const { attempt } = await startOrResumeAttempt(u, SET);
    await submitAnswer(attempt.id, u, { questionId: questionIds[0]!, selectedOptionKey: "A" });

    await completeAttempt(attempt.id, u);
    const summary = await getAttemptSummary(attempt.id, u);

    // The score comes from the answers table, so it is 1/4 regardless.
    expect(summary.score.correct).toBe(1);
    expect(summary.score.percent).toBe(25);
  });

  it("records the completion in the user's per-set rollup", async () => {
    const u = user("rollup");
    await finishAll(u);
    await db().delete(schema.userSetStats).where(eq(schema.userSetStats.userId, u)).run();

    const { attempt } = await startOrResumeAttempt(u, SET);
    await submitAnswer(attempt.id, u, { questionId: questionIds[0]!, selectedOptionKey: "A" });
    await completeAttempt(attempt.id, u);

    const stats = (
      await db()
        .select()
        .from(schema.userSetStats)
        .where(and(eq(schema.userSetStats.userId, u), eq(schema.userSetStats.setId, SET)))
    )[0];

    expect(stats).toBeTruthy();
    expect(stats!.completedCount).toBe(1);
    expect(stats!.bestCorrect).toBe(1);
    expect(stats!.bestTotal).toBe(4);
    expect(stats!.bestPercent).toBe(25);
  });
});

// ── §11.2 — transitions ──────────────────────────────────────────────────────

describe("state transitions", () => {
  it("does not accept answers once completed", async () => {
    const u = user("postComplete");
    await finishAll(u);
    const { attempt } = await startOrResumeAttempt(u, SET);
    await completeAttempt(attempt.id, u);

    await expect(
      submitAnswer(attempt.id, u, { questionId: questionIds[0]!, selectedOptionKey: "A" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("releases the active slot when abandoned, without scoring it", async () => {
    const u = user("abandon");
    await finishAll(u);
    const { attempt } = await startOrResumeAttempt(u, SET);
    await submitAnswer(attempt.id, u, { questionId: questionIds[0]!, selectedOptionKey: "A" });

    const abandoned = await abandonAttempt(attempt.id, u);
    expect(abandoned.status).toBe("abandoned");

    // The answer is KEPT — it is part of history.
    const answers = await db()
      .select()
      .from(schema.quizAttemptAnswers)
      .where(eq(schema.quizAttemptAnswers.attemptId, attempt.id));
    expect(answers).toHaveLength(1);

    // And a fresh attempt can now be started.
    const next = await startOrResumeAttempt(u, SET);
    expect(next.resumed).toBe(false);
    expect(next.attempt.id).not.toBe(attempt.id);
  });

  it("leaves partial progress intact on resume", async () => {
    const u = user("partial");
    await finishAll(u);
    const { attempt } = await startOrResumeAttempt(u, SET);

    await submitAnswer(attempt.id, u, { questionId: questionIds[0]!, selectedOptionKey: "A" });
    await submitAnswer(attempt.id, u, { questionId: questionIds[1]!, selectedOptionKey: "A" });

    const resumed = await startOrResumeAttempt(u, SET);
    const state = await getAttemptState(resumed.attempt.id, u);

    expect(state.answeredCount).toBe(2);
    expect(state.correctCount).toBe(2);
    // Resume must land on the first UNANSWERED question, not the last one seen.
    expect(state.resumeIndex).toBe(2);
    expect(state.answers.filter((a) => a.selectedOptionKey !== null)).toHaveLength(2);
  });
});
