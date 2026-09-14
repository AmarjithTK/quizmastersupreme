/**
 * Retroactive duplicate sweep (M11, PLAN.md §13.7).
 *
 * Dedupe is not only a generation-time concern: the bank accumulates near
 * duplicates over time, and lowering a threshold should reveal what it now
 * catches. This walks the existing questions, compares each against the bank,
 * and records `duplicate_flags` for a human to triage.
 *
 * Bounded on purpose (`limit`) — it is N FTS queries, so it is something an
 * admin runs deliberately rather than a background job that runs forever.
 *
 * Pairs are stored in a canonical order (lower id first) so comparing A→B and
 * B→A produces ONE flag rather than two mirror images.
 */

import { asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { duplicateFlags, newId, nowMs, questions } from "@/db/schema";
import { recordAudit } from "@/modules/audit";
import { getDedupeThresholds } from "@/modules/settings";
import { findTextDuplicates } from "./layer2-text";

const MAX_BOUND_PARAMS = 90;

export type SweepResult = {
  scanned: number;
  compared: number;
  flagsCreated: number;
  duplicatesFound: number;
};

export async function sweepExistingQuestions(
  options: { limit?: number; actorId?: string | null } = {},
): Promise<SweepResult> {
  const limit = Math.min(500, Math.max(1, options.limit ?? 100));
  const thresholds = await getDedupeThresholds();
  // Anything that a human would be asked to look at.
  const floor = thresholds.jaccardReview * 0.8;

  const candidates = await db()
    .select({ id: questions.id, stem: questions.stem })
    .from(questions)
    .where(sql`${questions.status} not in ('archived','rejected','duplicate')`)
    .orderBy(asc(questions.createdAt))
    .limit(limit);

  if (candidates.length === 0) {
    return { scanned: 0, compared: 0, flagsCreated: 0, duplicatesFound: 0 };
  }

  // Existing flags for these questions, so a re-run does not re-report them.
  const existing = new Set<string>();
  for (let i = 0; i < candidates.length; i += MAX_BOUND_PARAMS) {
    const chunk = candidates.slice(i, i + MAX_BOUND_PARAMS).map((c) => c.id);
    const rows = await db()
      .select({
        questionId: duplicateFlags.questionId,
        matchedQuestionId: duplicateFlags.matchedQuestionId,
      })
      .from(duplicateFlags)
      .where(inArray(duplicateFlags.questionId, chunk));
    for (const row of rows) existing.add(`${row.questionId}|${row.matchedQuestionId}`);
  }

  const now = nowMs();
  const pending: Array<typeof duplicateFlags.$inferInsert> = [];
  let compared = 0;
  let duplicatesFound = 0;

  for (const candidate of candidates) {
    const { matches } = await findTextDuplicates({
      stem: candidate.stem,
      excludeQuestionId: candidate.id,
      limit: 3,
      threshold: floor,
    });
    compared += 1;

    for (const match of matches) {
      duplicatesFound += 1;

      // Canonical order so A→B and B→A are one flag.
      const [first, second] =
        candidate.id < match.questionId
          ? [candidate.id, match.questionId]
          : [match.questionId, candidate.id];

      if (existing.has(`${first}|${second}`)) continue;

      pending.push({
        id: newId(),
        questionId: first!,
        matchedQuestionId: second!,
        layer: "text",
        similarity: match.similarity,
        detail: JSON.stringify({
          source: "sweep",
          comparedStem: candidate.stem,
          matchedStem: match.stem,
        }),
        status: "open",
        createdAt: now,
      });
      existing.add(`${first}|${second}`);
    }
  }

  let flagsCreated = 0;
  const perChunk = Math.max(1, Math.floor(MAX_BOUND_PARAMS / 8));
  for (let i = 0; i < pending.length; i += perChunk) {
    await db()
      .insert(duplicateFlags)
      .values(pending.slice(i, i + perChunk))
      .onConflictDoNothing();
    flagsCreated += pending.slice(i, i + perChunk).length;
  }

  if (options.actorId) {
    await recordAudit(options.actorId, "dedupe.sweep", "question", null, null, {
      scanned: candidates.length,
      compared,
      flagsCreated,
    });
  }

  return { scanned: candidates.length, compared, flagsCreated, duplicatesFound };
}

export type DuplicateFlagRow = {
  id: string;
  questionId: string;
  matchedQuestionId: string;
  layer: string;
  similarity: number;
  status: string;
  createdAt: number;
  questionStem: string;
  matchedStem: string;
  questionStatus: string;
  matchedStatus: string;
};

export async function listDuplicateFlags(
  options: { status?: string; limit?: number } = {},
): Promise<DuplicateFlagRow[]> {
  const rows = await db().all<{
    id: string;
    question_id: string;
    matched_question_id: string;
    layer: string;
    similarity: number;
    status: string;
    created_at: number;
    question_stem: string;
    matched_stem: string;
    question_status: string;
    matched_status: string;
  }>(sql`
    select
      f.id, f.question_id, f.matched_question_id, f.layer, f.similarity, f.status, f.created_at,
      q1.stem as question_stem, q2.stem as matched_stem,
      q1.status as question_status, q2.status as matched_status
    from duplicate_flags f
    join questions q1 on q1.id = f.question_id
    join questions q2 on q2.id = f.matched_question_id
    where f.status = ${options.status ?? "open"}
    order by f.similarity desc, f.created_at desc
    limit ${Math.min(200, Math.max(1, options.limit ?? 50))}
  `);

  return rows.map((row) => ({
    id: row.id,
    questionId: row.question_id,
    matchedQuestionId: row.matched_question_id,
    layer: row.layer,
    similarity: row.similarity,
    status: row.status,
    createdAt: row.created_at,
    questionStem: row.question_stem,
    matchedStem: row.matched_stem,
    questionStatus: row.question_status,
    matchedStatus: row.matched_status,
  }));
}

export async function resolveDuplicateFlag(
  id: string,
  action: "confirmed" | "dismissed" | "merged",
  actorId: string,
): Promise<void> {
  await db()
    .update(duplicateFlags)
    .set({ status: action, resolvedBy: actorId, resolvedAt: nowMs() })
    .where(eq(duplicateFlags.id, id));

  await recordAudit(actorId, `dedupe.${action}`, "duplicate_flag", id);
}

export async function openDuplicateCount(): Promise<number> {
  const row = (
    await db()
      .select({ n: sql<number>`count(*)` })
      .from(duplicateFlags)
      .where(eq(duplicateFlags.status, "open"))
  )[0];
  return Number(row?.n ?? 0);
}
