/**
 * Read-side reporting for the account area (M6).
 * PLAN.md §8.4.
 *
 * These are the only queries in the app that scan ACROSS attempts for a user.
 * They are deliberately bounded (GROUP BY on indexed columns, LIMIT on every
 * list) because they run on a page the user may refresh often.
 */

import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import { db } from "@/db/client";
import {
  categories,
  questions,
  quizAttemptAnswers,
  quizAttempts,
  quizSets,
  userQuestionSeen,
  userSetStats,
} from "@/db/schema";

export type DashboardStats = {
  answered: number;
  correct: number;
  accuracy: number;
  distinctQuestions: number;
  setsCompleted: number;
  setsStarted: number;
};

export type AttemptListItem = {
  attemptId: string;
  setId: string;
  setTitle: string;
  categoryTitle: string | null;
  status: string;
  answeredCount: number;
  totalQuestions: number;
  correctCount: number;
  percent: number;
  startedAt: number;
  completedAt: number | null;
};

export type WeakTopic = {
  topic: string;
  answered: number;
  correct: number;
  accuracy: number;
};

function toPercent(correct: number, total: number): number {
  return total > 0 ? Math.round((correct / total) * 100) : 0;
}

export async function getDashboardStats(userId: string): Promise<DashboardStats> {
  const attemptTotals = (
    await db()
      .select({
        answered: sql<number>`count(*)`,
        correct: sql<number>`coalesce(sum(case when ${quizAttemptAnswers.isCorrect} = 1 then 1 else 0 end), 0)`,
      })
      .from(quizAttemptAnswers)
      .innerJoin(quizAttempts, eq(quizAttempts.id, quizAttemptAnswers.attemptId))
      .where(eq(quizAttempts.userId, userId))
  )[0];

  const answered = Number(attemptTotals?.answered ?? 0);
  const correct = Number(attemptTotals?.correct ?? 0);

  const [distinct, completed, started] = await Promise.all([
    db()
      .select({ n: sql<number>`count(*)` })
      .from(userQuestionSeen)
      .where(eq(userQuestionSeen.userId, userId)),
    db()
      .select({ n: sql<number>`count(*)` })
      .from(userSetStats)
      .where(and(eq(userSetStats.userId, userId), gt(userSetStats.completedCount, 0))),
    db()
      .select({ n: sql<number>`count(*)` })
      .from(userSetStats)
      .where(eq(userSetStats.userId, userId)),
  ]);

  return {
    answered,
    correct,
    accuracy: toPercent(correct, answered),
    distinctQuestions: Number(distinct[0]?.n ?? 0),
    setsCompleted: Number(completed[0]?.n ?? 0),
    setsStarted: Number(started[0]?.n ?? 0),
  };
}

/** Attempts the user has not finished — the "Continue" list. */
export async function getInProgressAttempts(userId: string): Promise<AttemptListItem[]> {
  const rows = await db()
    .select({
      attemptId: quizAttempts.id,
      setId: quizAttempts.setId,
      setTitle: quizSets.title,
      categoryTitle: categories.title,
      status: quizAttempts.status,
      answeredCount: quizAttempts.answeredCount,
      totalQuestions: quizAttempts.totalQuestions,
      correctCount: quizAttempts.correctCount,
      startedAt: quizAttempts.startedAt,
      completedAt: quizAttempts.completedAt,
    })
    .from(quizAttempts)
    .innerJoin(quizSets, eq(quizSets.id, quizAttempts.setId))
    .innerJoin(categories, eq(categories.id, quizSets.categoryId))
    .where(and(eq(quizAttempts.userId, userId), eq(quizAttempts.status, "in_progress")))
    .orderBy(desc(quizAttempts.lastActivityAt))
    .limit(5);

  return rows.map((row) => ({
    ...row,
    percent: toPercent(row.answeredCount, row.totalQuestions),
  }));
}

export async function getUserHistory(
  userId: string,
  options: { page?: number; pageSize?: number; onlyFinished?: boolean } = {},
): Promise<{ rows: AttemptListItem[]; total: number; page: number; pageSize: number }> {
  const page = Math.max(1, options.page ?? 1);
  const pageSize = Math.min(50, Math.max(5, options.pageSize ?? 10));

  const where = options.onlyFinished
    ? and(eq(quizAttempts.userId, userId), sql`${quizAttempts.status} <> 'in_progress'`)
    : eq(quizAttempts.userId, userId);

  const [rows, countRow] = await Promise.all([
    db()
      .select({
        attemptId: quizAttempts.id,
        setId: quizAttempts.setId,
        setTitle: quizSets.title,
        categoryTitle: categories.title,
        status: quizAttempts.status,
        answeredCount: quizAttempts.answeredCount,
        totalQuestions: quizAttempts.totalQuestions,
        correctCount: quizAttempts.correctCount,
        startedAt: quizAttempts.startedAt,
        completedAt: quizAttempts.completedAt,
      })
      .from(quizAttempts)
      .innerJoin(quizSets, eq(quizSets.id, quizAttempts.setId))
      .innerJoin(categories, eq(categories.id, quizSets.categoryId))
      .where(where)
      .orderBy(desc(quizAttempts.startedAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db().select({ n: sql<number>`count(*)` }).from(quizAttempts).where(where),
  ]);

  return {
    rows: rows.map((row) => ({
      ...row,
      percent: toPercent(row.correctCount, row.totalQuestions),
    })),
    total: Number(countRow[0]?.n ?? 0),
    page,
    pageSize,
  };
}

/**
 * The most recent FINISHED attempt on one set, if any.
 *
 * Used to tell a learner "your last paper on this set ended X" when they start
 * a fresh one — otherwise a timed-out attempt silently vanishes from their view
 * and the score they earned is never shown.
 */
export async function getLatestFinishedAttempt(
  userId: string,
  setId: string,
): Promise<AttemptListItem | null> {
  const row = (
    await db()
      .select({
        attemptId: quizAttempts.id,
        setId: quizAttempts.setId,
        setTitle: quizSets.title,
        categoryTitle: categories.title,
        status: quizAttempts.status,
        answeredCount: quizAttempts.answeredCount,
        totalQuestions: quizAttempts.totalQuestions,
        correctCount: quizAttempts.correctCount,
        startedAt: quizAttempts.startedAt,
        completedAt: quizAttempts.completedAt,
      })
      .from(quizAttempts)
      .innerJoin(quizSets, eq(quizSets.id, quizAttempts.setId))
      .innerJoin(categories, eq(categories.id, quizSets.categoryId))
      .where(
        and(
          eq(quizAttempts.userId, userId),
          eq(quizAttempts.setId, setId),
          sql`${quizAttempts.status} <> 'in_progress'`,
        ),
      )
      .orderBy(desc(quizAttempts.startedAt))
      .limit(1)
  )[0];

  if (!row) return null;
  return { ...row, percent: toPercent(row.correctCount, row.totalQuestions) };
}

/**
 * Minutes to add before bucketing answers into days.
 *
 * The audience is Kerala, so a 1am study session should count as *that* day,
 * not the previous one. Hard-coded for now; if the platform goes multilingual
 * this becomes a per-user setting (PLAN.md §23).
 */
const DAY_BUCKET_OFFSET_MINUTES = 330; // IST, UTC+5:30

export type Streak = {
  current: number;
  longest: number;
  /** Days with at least one answer, most recent first (ISO yyyy-mm-dd). */
  activeDays: string[];
};

/**
 * Consecutive-day study streak, computed from when answers were given.
 *
 * Deliberately based on ANSWERING rather than opening the app: a streak you can
 * keep by logging in is not a study streak.
 */
export async function getStreak(userId: string, lookbackDays = 400): Promise<Streak> {
  const rows = await db()
    .select({
      day: sql<string>`date((${quizAttemptAnswers.answeredAt} / 1000) + ${DAY_BUCKET_OFFSET_MINUTES * 60}, 'unixepoch')`,
    })
    .from(quizAttemptAnswers)
    .innerJoin(quizAttempts, eq(quizAttempts.id, quizAttemptAnswers.attemptId))
    .where(eq(quizAttempts.userId, userId))
    .groupBy(sql`1`)
    .orderBy(desc(sql`1`))
    .limit(lookbackDays);

  const days = rows.map((r) => r.day).filter(Boolean);
  if (days.length === 0) return { current: 0, longest: 0, activeDays: [] };

  const dayMs = 24 * 60 * 60 * 1000;
  const toTime = (iso: string) => new Date(`${iso}T00:00:00Z`).getTime();

  // Longest run anywhere in the history.
  let longest = 1;
  let run = 1;
  for (let i = 1; i < days.length; i++) {
    if (toTime(days[i - 1]!) - toTime(days[i]!) === dayMs) {
      run++;
      longest = Math.max(longest, run);
    } else {
      run = 1;
    }
  }

  // Current run: must include today or yesterday, or the streak is broken.
  const todayIso = new Date(Date.now() + DAY_BUCKET_OFFSET_MINUTES * 60_000)
    .toISOString()
    .slice(0, 10);
  const today = toTime(todayIso);

  let current = 0;
  const gapToToday = (today - toTime(days[0]!)) / dayMs;
  if (gapToToday === 0 || gapToToday === 1) {
    current = 1;
    for (let i = 1; i < days.length; i++) {
      if (toTime(days[i - 1]!) - toTime(days[i]!) === dayMs) current++;
      else break;
    }
  }

  return { current, longest, activeDays: days.slice(0, 30) };
}

/** Topics the user is weakest at, from questions they have actually attempted.
 *
 * Requires at least `minAnswered` attempts on a topic before it is reported —
 * one unlucky wrong answer should not label a subject as a weakness.
 */
export async function getWeakTopics(userId: string, minAnswered = 3): Promise<WeakTopic[]> {
  const rows = await db()
    .select({
      topic: questions.topic,
      answered: sql<number>`count(*)`,
      correct: sql<number>`coalesce(sum(case when ${quizAttemptAnswers.isCorrect} = 1 then 1 else 0 end), 0)`,
    })
    .from(quizAttemptAnswers)
    .innerJoin(quizAttempts, eq(quizAttempts.id, quizAttemptAnswers.attemptId))
    .innerJoin(questions, eq(questions.id, quizAttemptAnswers.questionId))
    .where(and(eq(quizAttempts.userId, userId), sql`${questions.topic} is not null`))
    .groupBy(questions.topic)
    .having(sql`count(*) >= ${minAnswered}`)
    .orderBy(asc(sql`(coalesce(sum(case when ${quizAttemptAnswers.isCorrect} = 1 then 1 else 0 end), 0) * 1.0) / count(*)`))
    .limit(5);

  return rows.map((row) => ({
    topic: row.topic ?? "Unknown",
    answered: Number(row.answered),
    correct: Number(row.correct),
    accuracy: toPercent(Number(row.correct), Number(row.answered)),
  }));
}
