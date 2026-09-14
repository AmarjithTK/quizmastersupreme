/**
 * Set membership — `question_set_questions`.
 * PLAN.md §6.1, §9.2.
 *
 * A question can live in MANY sets (the N:M join is the whole point: one good
 * question can serve "Kerala Previous Year 2025", "Linux Basics" and a
 * revision paper at once). That is also why detaching never deletes the
 * question itself.
 */

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { db } from "@/db/client";
import { nowMs, questions, questionSetQuestions, quizSets } from "@/db/schema";
import { notFound } from "@/lib/errors";
import { recordAudit } from "@/modules/audit";

/** Conservative bound-parameter budget (PLAN.md §6.5). */
const MAX_BOUND_PARAMS = 90;

export type SetQuestionRow = {
  questionId: string;
  sortOrder: number;
  stem: string;
  difficulty: string;
  topic: string | null;
  status: string;
  optionCount: number;
};

export async function listSetQuestions(setId: string): Promise<SetQuestionRow[]> {
  const rows = await db()
    .select({
      questionId: questions.id,
      sortOrder: questionSetQuestions.sortOrder,
      stem: questions.stem,
      difficulty: questions.difficulty,
      topic: questions.topic,
      status: questions.status,
      optionCount: sql<number>`(select count(*) from question_options qo where qo.question_id = ${questions.id})`,
    })
    .from(questionSetQuestions)
    .innerJoin(questions, eq(questions.id, questionSetQuestions.questionId))
    .where(eq(questionSetQuestions.setId, setId))
    .orderBy(asc(questionSetQuestions.sortOrder));

  return rows.map((row) => ({ ...row, optionCount: Number(row.optionCount ?? 0) }));
}

async function assertSetExists(setId: string): Promise<void> {
  const row = (await db().select({ id: quizSets.id }).from(quizSets).where(eq(quizSets.id, setId)).limit(1))[0];
  if (!row) throw notFound("Quiz set not found.");
}

/**
 * Attach questions to a set, appended in the order given.
 *
 * Already-attached questions are skipped rather than moved, so re-running an
 * import or a bulk action is safe and idempotent.
 */
export async function attachQuestions(
  setId: string,
  questionIds: string[],
  actorId: string,
): Promise<{ added: number; skipped: number }> {
  await assertSetExists(setId);

  const unique = [...new Set(questionIds)].filter(Boolean);
  if (unique.length === 0) return { added: 0, skipped: 0 };

  // Only attach questions that actually exist; report the rest as skipped.
  const existingQuestions = await db()
    .select({ id: questions.id })
    .from(questions)
    .where(inArray(questions.id, unique));
  const existingIds = new Set(existingQuestions.map((q) => q.id));

  const alreadyAttached = await db()
    .select({ questionId: questionSetQuestions.questionId })
    .from(questionSetQuestions)
    .where(
      and(
        eq(questionSetQuestions.setId, setId),
        inArray(questionSetQuestions.questionId, [...existingIds]),
      ),
    );
  const attachedIds = new Set(alreadyAttached.map((r) => r.questionId));

  const maxRow = (
    await db()
      .select({ max: sql<number>`coalesce(max(${questionSetQuestions.sortOrder}), -1)` })
      .from(questionSetQuestions)
      .where(eq(questionSetQuestions.setId, setId))
  )[0];
  let nextOrder = Number(maxRow?.max ?? -1) + 1;

  // Iterate `unique` (the CALLER's order), not the query result. A SQL `IN`
  // query returns rows in whatever order the planner likes, so mapping over it
  // would silently scramble the paper's question order.
  const toInsert = unique
    .filter((id) => existingIds.has(id) && !attachedIds.has(id))
    .map((questionId) => ({
      setId,
      questionId,
      sortOrder: nextOrder++,
      addedAt: nowMs(),
    }));

  const perChunk = Math.max(1, Math.floor(MAX_BOUND_PARAMS / 4));
  for (let i = 0; i < toInsert.length; i += perChunk) {
    await db()
      .insert(questionSetQuestions)
      .values(toInsert.slice(i, i + perChunk))
      .onConflictDoNothing();
  }

  if (toInsert.length > 0) {
    await recordAudit(actorId, "set.attach_questions", "quiz_set", setId, null, {
      added: toInsert.length,
      questionIds: toInsert.map((r) => r.questionId),
    });
  }

  return { added: toInsert.length, skipped: unique.length - toInsert.length };
}

/** Detach from THIS set only — the question row itself is untouched. */
export async function detachQuestions(
  setId: string,
  questionIds: string[],
  actorId: string,
): Promise<number> {
  const unique = [...new Set(questionIds)].filter(Boolean);
  if (unique.length === 0) return 0;

  await db()
    .delete(questionSetQuestions)
    .where(
      and(eq(questionSetQuestions.setId, setId), inArray(questionSetQuestions.questionId, unique)),
    );

  await recordAudit(actorId, "set.detach_questions", "quiz_set", setId, null, {
    questionIds: unique,
  });
  return unique.length;
}

/** Rewrite the order of a set's questions to match `orderedQuestionIds`. */
export async function reorderSetQuestions(
  setId: string,
  orderedQuestionIds: string[],
  actorId: string,
): Promise<void> {
  if (orderedQuestionIds.length === 0) return;

  const statements = orderedQuestionIds.map((questionId, index) =>
    db()
      .update(questionSetQuestions)
      .set({ sortOrder: index })
      .where(
        and(
          eq(questionSetQuestions.setId, setId),
          eq(questionSetQuestions.questionId, questionId),
        ),
      ),
  ) as unknown as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]];

  await db().batch(statements);
  await recordAudit(actorId, "set.reorder_questions", "quiz_set", setId, null, {
    orderedQuestionIds,
  });
}
