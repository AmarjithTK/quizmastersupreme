/**
 * Permanent deletion of questions.
 *
 * WHY THIS FILE EXISTS: the DELETE endpoint used to be an alias for "archive",
 * and the service said "Archived, not deleted — attempts reference answers via
 * question_id". That is the real constraint, so delete is implemented WITH the
 * guard rather than without it:
 *
 *   - a question no learner has answered is deleted for real (options, Q Set
 *     links and "seen" rows cascade, the FTS trigger cleans search);
 *   - a question that HAS been answered is refused with a 409 naming the count,
 *     because the FK cascades and deleting it would erase learner history.
 */

import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { getPlatformProxy } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, setDbForTests } from "@/db/client";
import * as schema from "@/db/schema";
import { createCategory, createSet } from "@/modules/catalog";
import {
  attachQuestions,
  bulkDeleteQuestions,
  createQuestion,
  deleteQuestion,
  getQuestionForAdmin,
} from "@/modules/questions";

const ACTOR = "user__delete_test";
const TOPIC = "QuestionDeleteTest";

const BACKSTORY =
  "A sufficiently long backstory for the delete tests, written as prose so the schema's " +
  "minimum length is satisfied and the review screen has something real to render.";

function draft(stem: string) {
  return {
    stem,
    options: [
      { key: "A" as const, body: "Zephyr" },
      { key: "B" as const, body: "Quartz" },
      { key: "C" as const, body: "Nimbus" },
      { key: "D" as const, body: "Onyx" },
    ],
    correctOptionKey: "A" as const,
    explanation: "Because Zephyr is correct.",
    backstory: BACKSTORY,
    difficulty: "easy",
    topic: TOPIC,
    tags: [] as string[],
  };
}

let proxy: { env: { DB: D1Database }; dispose: () => Promise<void> } | null = null;

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
  const rows = await db()
    .select({ id: schema.questions.id })
    .from(schema.questions)
    .where(eq(schema.questions.topic, TOPIC));
  for (const row of rows) {
    await db().delete(schema.questions).where(eq(schema.questions.id, row.id)).run();
  }
  // Attempts/answers created by the guard test.
  await db().delete(schema.quizAttemptAnswers).run();
  await db().delete(schema.quizAttempts).run();
}

/**
 * Rows in the FTS index matching a term. `questions_fts` is an FTS5 virtual
 * table (with insert/update/delete triggers), so it is queried with raw SQL.
 */
async function ftsMatches(term: string): Promise<number> {
  const rows = await db().all<{ n: number }>(
    sql`select count(*) as n from questions_fts where questions_fts match ${term}`,
  );
  return Number(rows[0]?.n ?? 0);
}

describe("deleteQuestion", () => {
  it("deletes the question with its options, Q Set links and search row", async () => {
    const category = await createCategory({ title: "Delete Subject" }, ACTOR);
    const set = await createSet({ categoryId: category.id, title: "Delete Set" }, ACTOR);

    const { question } = await createQuestion(draft("Delete me alpha question?"), ACTOR);
    await attachQuestions(set.id, [question.id], ACTOR);

    // Present everywhere before the delete.
    expect((await db().select().from(schema.questionOptions).where(eq(schema.questionOptions.questionId, question.id))).length).toBe(4);
    expect((await db().select().from(schema.questionSetQuestions).where(eq(schema.questionSetQuestions.questionId, question.id))).length).toBe(1);

    const outcome = await deleteQuestion(question.id, ACTOR);
    expect(outcome.stem).toBe(question.stem);
    expect(outcome.removedFromSets).toBe(1);

    // Gone from every table.
    expect((await db().select().from(schema.questions).where(eq(schema.questions.id, question.id))).length).toBe(0);
    expect((await db().select().from(schema.questionOptions).where(eq(schema.questionOptions.questionId, question.id))).length).toBe(0);
    expect((await db().select().from(schema.questionSetQuestions).where(eq(schema.questionSetQuestions.questionId, question.id))).length).toBe(0);

    // 404 afterwards.
    await expect(getQuestionForAdmin(question.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("cleans the FTS index via the delete trigger", async () => {
    // A word that appears nowhere else, so the count is unambiguous.
    const { question } = await createQuestion(draft("Zorbulon searchable probe?"), ACTOR);
    expect(await ftsMatches("zorbulon")).toBe(1);

    await deleteQuestion(question.id, ACTOR);
    expect(await ftsMatches("zorbulon")).toBe(0);
  });

  it("REFUSES to delete a question a learner has answered, and says why", async () => {
    const category = await createCategory({ title: "Delete Guard Subject" }, ACTOR);
    const set = await createSet({ categoryId: category.id, title: "Delete Guard Set" }, ACTOR);
    const { question } = await createQuestion(draft("Answered delete guard question?"), ACTOR);
    await attachQuestions(set.id, [question.id], ACTOR);

    // A real attempt + answer row, so the FK really does cascade on delete.
    const now = Date.now();
    await db().insert(schema.quizAttempts).values({
      id: "attempt__delete_guard",
      userId: ACTOR,
      setId: set.id,
      status: "completed",
      questionOrder: JSON.stringify([question.id]),
      totalQuestions: 1,
      currentIndex: 1,
      answeredCount: 1,
      correctCount: 1,
      wrongCount: 0,
      skippedCount: 0,
      timeSpentMs: 1_000,
      startedAt: now,
      lastActivityAt: now,
      completedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await db().insert(schema.quizAttemptAnswers).values({
      attemptId: "attempt__delete_guard",
      questionId: question.id,
      questionIndex: 0,
      selectedOptionKey: "A",
      isCorrect: 1,
      timeTakenMs: 1_000,
      answeredAt: now,
    });

    await expect(deleteQuestion(question.id, ACTOR)).rejects.toMatchObject({
      code: "CONFLICT",
    });

    // The refusal names the count and points at archiving…
    const error = await deleteQuestion(question.id, ACTOR).catch((e: Error) => e);
    expect((error as Error).message).toMatch(/answered in 1 attempt/i);
    expect((error as Error).message).toMatch(/archive/i);

    // …and the question AND the learner's answer are both still there.
    expect((await db().select().from(schema.questions).where(eq(schema.questions.id, question.id))).length).toBe(1);
    expect(
      (await db()
        .select()
        .from(schema.quizAttemptAnswers)
        .where(eq(schema.quizAttemptAnswers.questionId, question.id))).length,
    ).toBe(1);
  });

  it("reports an unknown id as NOT_FOUND", async () => {
    await expect(deleteQuestion("question__nope", ACTOR)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("bulk delete removes the deletable and reports the rest by id", async () => {
    const category = await createCategory({ title: "Bulk Delete Subject" }, ACTOR);
    const set = await createSet({ categoryId: category.id, title: "Bulk Delete Set" }, ACTOR);

    const free = await createQuestion(draft("Bulk delete free question?"), ACTOR);
    const answered = await createQuestion(draft("Bulk delete answered question?"), ACTOR);
    await attachQuestions(set.id, [free.question.id, answered.question.id], ACTOR);

    const now = Date.now();
    await db().insert(schema.quizAttempts).values({
      id: "attempt__bulk_delete",
      userId: ACTOR,
      setId: set.id,
      status: "completed",
      questionOrder: JSON.stringify([answered.question.id]),
      totalQuestions: 1,
      currentIndex: 1,
      answeredCount: 1,
      correctCount: 1,
      wrongCount: 0,
      skippedCount: 0,
      timeSpentMs: 1_000,
      startedAt: now,
      lastActivityAt: now,
      completedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await db().insert(schema.quizAttemptAnswers).values({
      attemptId: "attempt__bulk_delete",
      questionId: answered.question.id,
      questionIndex: 0,
      selectedOptionKey: "B",
      isCorrect: 0,
      timeTakenMs: 1_000,
      answeredAt: now,
    });

    const result = await bulkDeleteQuestions(
      [free.question.id, answered.question.id, "question__missing"],
      ACTOR,
    );

    expect(result.deleted).toBe(1);
    expect(result.deletedIds).toEqual([free.question.id]);
    // Both failures are reported with a reason, not swallowed.
    expect(result.blocked).toHaveLength(2);
    expect(result.blocked.map((b) => b.id).sort()).toEqual(
      [answered.question.id, "question__missing"].sort(),
    );
    expect(result.blocked.every((b) => b.reason.length > 0)).toBe(true);
  });

  it("records a question.delete audit entry with the before-state", async () => {
    const { question } = await createQuestion(draft("Audited delete question?"), ACTOR);
    await deleteQuestion(question.id, ACTOR);

    const entries = await db()
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.entityId, question.id));
    const entry = entries.find((row) => row.action === "question.delete");
    expect(entry).toBeTruthy();
    expect(entry!.beforeJson).toContain(question.stem);
  });
});
