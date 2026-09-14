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
 * Topics the user is weakest at, from questions they have actually attempted.
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
