/**
 * Account dashboard + history queries (M6) against real D1.
 *
 * These aggregate across attempts, so they are the easiest place for an
 * off-by-one or a wrong denominator to hide. Each assertion checks a number a
 * learner would actually see.
 */

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { getPlatformProxy } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, setDbForTests } from "@/db/client";
import * as schema from "@/db/schema";
import { createQuestion } from "@/modules/questions";
import {
  getDashboardStats,
  getInProgressAttempts,
  getStreak,
  getUserHistory,
  getWeakTopics,
} from "@/modules/progress";
import { completeAttempt, startOrResumeAttempt, submitAnswer } from "@/modules/quiz";

const ACTOR = "user__dashboard_test";
const CATEGORY = "cat__dashboard_test";
const SET = "set__dashboard_test";

let proxy: { env: { DB: D1Database }; dispose: () => Promise<void> } | null = null;
let questionIds: string[] = [];

const STORY =
  "A long enough backstory for the dashboard tests to satisfy the validation minimum, written " +
  "as real prose so the validator accepts it.";

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
      slug: "dashboard-test",
      title: "Dashboard Test",
      sortOrder: 0,
      status: "published",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();

  await db()
    .insert(schema.quizSets)
    .values({
      id: SET,
      categoryId: CATEGORY,
      slug: "dashboard-test-set",
      title: "Dashboard Test Set",
      mode: "practice",
      difficulty: "easy",
      shuffleQuestions: 0,
      shuffleOptions: 0,
      sortOrder: 0,
      status: "published",
      publishedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();

  for (const [index, stem] of [
    "Dashboard question one about nothing in particular?",
    "Dashboard question two about something else entirely?",
    "Dashboard question three with different wording?",
    "Dashboard question four to round the paper out?",
  ].entries()) {
    const { question } = await createQuestion(
      {
        stem,
        options: [
          { key: "A", body: "Zephyr" },
          { key: "B", body: "Quartz" },
          { key: "C", body: "Nimbus" },
          { key: "D", body: "Onyx" },
        ],
        correctOptionKey: "A",
        explanation: "Zephyr is correct.",
        backstory: STORY,
        difficulty: "easy",
        topic: index < 2 ? "Alpha Topic" : "Beta Topic",
        tags: ["dashboard-test"],
      },
      ACTOR,
      { status: "active" },
    );
    questionIds.push(question.id);
    await db()
      .insert(schema.questionSetQuestions)
      .values({ setId: SET, questionId: question.id, sortOrder: index, addedAt: now })
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
  await resetUserProgress();
  await db().delete(schema.questionSetQuestions).where(eq(schema.questionSetQuestions.setId, SET)).run();
  await db().delete(schema.quizSets).where(eq(schema.quizSets.categoryId, CATEGORY)).run();
  await db().delete(schema.categories).where(eq(schema.categories.id, CATEGORY)).run();
  await db().delete(schema.categories).where(eq(schema.categories.slug, "dashboard-test")).run();
}

/**
 * Clear only this user's attempt history and ledger.
 *
 * Distinct from `cleanup()` on purpose: cleanup removes the FIXTURES too, so
 * calling it mid-test would delete the very set the next test needs.
 */
async function resetUserProgress(): Promise<void> {
  await db().delete(schema.quizAttempts).where(eq(schema.quizAttempts.setId, SET)).run();
  await db().delete(schema.userQuestionSeen).where(eq(schema.userQuestionSeen.userId, ACTOR)).run();
  await db().delete(schema.userSetStats).where(eq(schema.userSetStats.userId, ACTOR)).run();
}

async function answerAndComplete(correctCount: number, wrongCount: number, answered: number) {
  const { attempt } = await startOrResumeAttempt(ACTOR, SET);
  for (let i = 0; i < answered; i++) {
    const key = i < correctCount ? "A" : wrongCount > 0 && i < correctCount + wrongCount ? "B" : "A";
    await submitAnswer(attempt.id, ACTOR, { questionId: questionIds[i]!, selectedOptionKey: key });
  }
  await completeAttempt(attempt.id, ACTOR);
  return attempt.id;
}

// ── stats ────────────────────────────────────────────────────────────────────

describe("getDashboardStats", () => {
  it("aggregates answered, correct and accuracy across attempts", async () => {
    await resetUserProgress();

    // 3 answered: 2 right, 1 wrong.
    await answerAndComplete(2, 1, 3);

    const stats = await getDashboardStats(ACTOR);

    expect(stats.answered).toBe(3);
    expect(stats.correct).toBe(2);
    // 2/3 = 66.67 -> 67
    expect(stats.accuracy).toBe(67);
    expect(stats.distinctQuestions).toBe(3);
    expect(stats.setsStarted).toBe(1);
    expect(stats.setsCompleted).toBe(1);
  });

  it("reports zeroes rather than NaN for a user with no attempts", async () => {
    const stats = await getDashboardStats("user__nobody_at_all");
    expect(stats.answered).toBe(0);
    expect(stats.accuracy).toBe(0);
    expect(stats.setsCompleted).toBe(0);
  });
});

// ── history ──────────────────────────────────────────────────────────────────

describe("getUserHistory", () => {
  it("lists finished attempts with a percent over the FULL paper", async () => {
    const history = await getUserHistory(ACTOR, { pageSize: 10 });

    expect(history.total).toBeGreaterThan(0);
    const row = history.rows[0]!;
    expect(row.setTitle).toBe("Dashboard Test Set");
    expect(row.categoryTitle).toBe("Dashboard Test");
    // 2 correct out of a 4-question paper = 50%, not 2/3 = 67%.
    expect(row.percent).toBe(50);
  });

  it("excludes in-progress attempts when onlyFinished is set", async () => {
    await startOrResumeAttempt(ACTOR, SET); // leaves one open

    const all = await getUserHistory(ACTOR, { pageSize: 50 });
    const finished = await getUserHistory(ACTOR, { pageSize: 50, onlyFinished: true });

    expect(all.total).toBeGreaterThan(finished.total);
    expect(finished.rows.every((r) => r.status !== "in_progress")).toBe(true);
  });

  it("paginates and clamps the page size to a sane range", async () => {
    const first = await getUserHistory(ACTOR, { page: 1, pageSize: 1 });
    // The query clamps the page size into [5, 50] so a caller cannot ask for a
    // single row (or the whole table) by accident.
    expect(first.pageSize).toBe(5);
    expect(first.page).toBe(1);
    expect(first.rows.length).toBeLessThanOrEqual(5);

    const huge = await getUserHistory(ACTOR, { page: 1, pageSize: 999 });
    expect(huge.pageSize).toBe(50);

    const second = await getUserHistory(ACTOR, { page: 2, pageSize: 5 });
    expect(second.page).toBe(2);
  });
});

// ── in progress ──────────────────────────────────────────────────────────────

describe("getInProgressAttempts", () => {
  it("returns only unfinished attempts, with resume progress", async () => {
    const rows = await getInProgressAttempts(ACTOR);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.status === "in_progress")).toBe(true);
    expect(rows[0]!.percent).toBeGreaterThanOrEqual(0);
    expect(rows[0]!.totalQuestions).toBe(4);
  });

  it("returns nothing for a user who has never started", async () => {
    expect(await getInProgressAttempts("user__nobody_at_all")).toEqual([]);
  });
});

// ── weak topics ──────────────────────────────────────────────────────────────

// ── streak ───────────────────────────────────────────────────────────────────

describe("getStreak", () => {
  it("is zero for someone who has never answered anything", async () => {
    const streak = await getStreak("user__nobody_at_all");
    expect(streak).toEqual({ current: 0, longest: 0, activeDays: [] });
  });

  it("counts today once an answer has been given", async () => {
    await resetUserProgress();
    await answerAndComplete(2, 1, 3);

    const streak = await getStreak(ACTOR);
    expect(streak.current).toBeGreaterThanOrEqual(1);
    expect(streak.longest).toBeGreaterThanOrEqual(streak.current);
    expect(streak.activeDays.length).toBeGreaterThanOrEqual(1);
  });

  it("returns days in descending order", async () => {
    const streak = await getStreak(ACTOR);
    const sorted = [...streak.activeDays].sort().reverse();
    expect(streak.activeDays).toEqual(sorted);
  });
});

describe("getWeakTopics", () => {
  it("respects the minimum-attempts threshold", async () => {
    // With a threshold of 5, no topic qualifies yet.
    expect(await getWeakTopics(ACTOR, 5)).toEqual([]);

    // With a threshold of 1, topics appear and are ordered weakest-first.
    const topics = await getWeakTopics(ACTOR, 1);
    expect(topics.length).toBeGreaterThan(0);
    for (let i = 1; i < topics.length; i++) {
      expect(topics[i - 1]!.accuracy).toBeLessThanOrEqual(topics[i]!.accuracy);
    }
  });

  it("reports an accuracy consistent with its own counts", async () => {
    const topics = await getWeakTopics(ACTOR, 1);
    for (const topic of topics) {
      expect(topic.accuracy).toBe(Math.round((topic.correct / topic.answered) * 100));
    }
  });
});
