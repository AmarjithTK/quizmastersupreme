/**
 * Progress module — owns `user_question_seen` and `user_set_stats`.
 * PLAN.md §7.4, §6.2.
 *
 * `user_set_stats` is a denormalized rollup that exists purely so screen 2 can
 * render sixty cards with progress in ONE query instead of sixty aggregate
 * scans (§17.2). Everything here is derived data: it can be rebuilt from
 * `quiz_attempts` + `quiz_attempt_answers` at any time.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { nowMs, userQuestionSeen, userSetStats } from "@/db/schema";

/**
 * Record that a user has answered a question, across ALL attempts.
 *
 * This is what answers "have I seen this before?" — the ledger behind the
 * "you have already covered this set" behaviour (§8.4).
 */
export async function recordAnswerSeen(
  userId: string,
  questionId: string,
  isCorrect: boolean | null,
  at: number = nowMs(),
): Promise<void> {
  const correctDelta = isCorrect === true ? 1 : 0;
  const lastIsCorrect = isCorrect === null ? null : isCorrect ? 1 : 0;

  await db()
    .insert(userQuestionSeen)
    .values({
      userId,
      questionId,
      firstSeenAt: at,
      lastSeenAt: at,
      timesSeen: 1,
      timesCorrect: correctDelta,
      lastIsCorrect,
    })
    .onConflictDoUpdate({
      target: [userQuestionSeen.userId, userQuestionSeen.questionId],
      set: {
        lastSeenAt: at,
        timesSeen: sql`${userQuestionSeen.timesSeen} + 1`,
        timesCorrect: sql`${userQuestionSeen.timesCorrect} + ${correctDelta}`,
        lastIsCorrect,
      },
    });
}

/** Bump the attempt counter when a run STARTS, so abandoning still counts. */
export async function recordAttemptStarted(
  userId: string,
  setId: string,
  at: number = nowMs(),
): Promise<void> {
  await db()
    .insert(userSetStats)
    .values({
      userId,
      setId,
      attemptsCount: 1,
      completedCount: 0,
      bestCorrect: 0,
      bestTotal: 0,
      bestPercent: null,
      questionsSeen: 0,
      lastAttemptAt: at,
      firstCompletedAt: null,
    })
    .onConflictDoUpdate({
      target: [userSetStats.userId, userSetStats.setId],
      set: {
        attemptsCount: sql`${userSetStats.attemptsCount} + 1`,
        lastAttemptAt: at,
      },
    });
}

/**
 * Record a FINISHED attempt: counts plus best-score tracking.
 *
 * Only ever moves the "best" numbers upward, so replaying a set can improve a
 * personal best but never lower it.
 */
export async function recordSetCompletion(
  userId: string,
  setId: string,
  result: { correct: number; total: number; at?: number },
): Promise<void> {
  const at = result.at ?? nowMs();
  const percent = result.total > 0 ? Math.round((result.correct / result.total) * 100) : 0;
  const seen = await countQuestionsSeenForSet(userId, setId);

  await db()
    .insert(userSetStats)
    .values({
      userId,
      setId,
      attemptsCount: 1,
      completedCount: 1,
      bestCorrect: result.correct,
      bestTotal: result.total,
      bestPercent: percent,
      questionsSeen: seen,
      lastAttemptAt: at,
      firstCompletedAt: at,
    })
    .onConflictDoUpdate({
      target: [userSetStats.userId, userSetStats.setId],
      set: {
        completedCount: sql`${userSetStats.completedCount} + 1`,
        // SQLite scalar max() returns NULL if ANY argument is NULL, hence the
        // coalesce on the existing value.
        bestCorrect: sql`max(${userSetStats.bestCorrect}, ${result.correct})`,
        bestTotal: sql`max(${userSetStats.bestTotal}, ${result.total})`,
        bestPercent: sql`max(coalesce(${userSetStats.bestPercent}, -1), ${percent})`,
        questionsSeen: sql`max(${userSetStats.questionsSeen}, ${seen})`,
        lastAttemptAt: at,
        firstCompletedAt: sql`coalesce(${userSetStats.firstCompletedAt}, ${at})`,
      },
    });
}

/** Distinct questions from this set that the user has ever answered. */
export async function countQuestionsSeenForSet(userId: string, setId: string): Promise<number> {
  const row = (
    await db()
      .select({ n: sql<number>`count(*)` })
      .from(userQuestionSeen)
      .where(
        and(
          eq(userQuestionSeen.userId, userId),
          sql`${userQuestionSeen.questionId} in (
            select question_id from question_set_questions where set_id = ${setId}
          )`,
        ),
      )
  )[0];
  return Number(row?.n ?? 0);
}

/** Per-set stats for a user, or null if they have never touched the set. */
export async function getSetStats(userId: string, setId: string) {
  const row = (
    await db()
      .select()
      .from(userSetStats)
      .where(and(eq(userSetStats.userId, userId), eq(userSetStats.setId, setId)))
      .limit(1)
  )[0];
  return row ?? null;
}

/** Bulk version for screen 2: stats for every set in one category. */
export async function getStatsForSets(userId: string, setIds: string[]) {
  if (setIds.length === 0) return new Map<string, typeof userSetStats.$inferSelect>();

  const rows = await db()
    .select()
    .from(userSetStats)
    .where(and(eq(userSetStats.userId, userId), inArray(userSetStats.setId, setIds)));

  return new Map(rows.map((row) => [row.setId, row]));
}
