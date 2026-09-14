/**
 * Question funnel + set membership invariants (M4) against real D1.
 *
 * The ordering test is a regression guard: the first implementation built the
 * insert list from a SQL `IN` result, so a set's question order came out in
 * whatever order the planner returned. Question order IS the paper.
 */

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { getPlatformProxy } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, setDbForTests } from "@/db/client";
import * as schema from "@/db/schema";
import type { QuestionDraft } from "@/modules/questions";
import {
  attachQuestions,
  createQuestion,
  detachQuestions,
  getQuestionForAdmin,
  listQuestionsForAdmin,
  listSetQuestions,
  reorderSetQuestions,
  setQuestionStatus,
  updateQuestion,
} from "@/modules/questions";

const ACTOR = "user__questions_test";
const CATEGORY = "cat__questions_test";
const SET = "set__questions_test";

let proxy: { env: { DB: D1Database }; dispose: () => Promise<void> } | null = null;

/** Long enough to satisfy the backstory minimum. */
const STORY =
  "This is a deliberately long backstory used by the test suite so that the validation layer accepts it. " +
  "It explains the surrounding context, which is the part a learner actually revises from.";

function draft(overrides: Partial<QuestionDraft> = {}): QuestionDraft {
  return {
    stem: "Which data structure processes elements in first-in, first-out order?",
    options: [
      { key: "A", body: "Stack" },
      { key: "B", body: "Queue" },
      { key: "C", body: "Tree" },
      { key: "D", body: "Heap" },
    ],
    correctOptionKey: "B",
    explanation: "A queue is FIFO.",
    backstory: STORY,
    difficulty: "easy",
    topic: "Data Structures",
    tags: ["test"],
    ...overrides,
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
      slug: "questions-test",
      title: "Questions Test",
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
      slug: "questions-test-set",
      title: "Questions Test Set",
      mode: "practice",
      difficulty: "easy",
      shuffleQuestions: 0,
      shuffleOptions: 0,
      sortOrder: 0,
      status: "draft",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
});

afterAll(async () => {
  await cleanup();
  await proxy?.dispose();
  proxy = null;
  setDbForTests(null);
});

async function cleanup(): Promise<void> {
  await db().delete(schema.quizSets).where(eq(schema.quizSets.categoryId, CATEGORY)).run();
  await db().delete(schema.categories).where(eq(schema.categories.id, CATEGORY)).run();
  await db().delete(schema.categories).where(eq(schema.categories.slug, "questions-test")).run();
  await db().delete(schema.questions).where(eq(schema.questions.origin, "manual")).run();
  await db().delete(schema.questions).where(eq(schema.questions.origin, "test")).run();
}

// ── the funnel ───────────────────────────────────────────────────────────────

describe("createQuestion funnel", () => {
  it("persists the question, its options, and the correct flag", async () => {
    const { question } = await createQuestion(draft({ stem: "Funnel happy path question?" }), ACTOR);
    const loaded = await getQuestionForAdmin(question.id);

    expect(loaded.options).toHaveLength(4);
    expect(loaded.options.find((o) => o.isCorrect === 1)?.key).toBe("B");
    expect(loaded.status).toBe("draft");
    expect(loaded.normalizedHash).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.simhash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("rejects a question with only three options", async () => {
    await expect(
      createQuestion(
        draft({
          stem: "Only three options supplied here?",
          options: [
            { key: "A", body: "One" },
            { key: "B", body: "Two" },
            { key: "C", body: "Three" },
          ],
        }),
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("rejects a backstory that is too short", async () => {
    await expect(
      createQuestion(draft({ stem: "Backstory too short here?", backstory: "Nope." }), ACTOR),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("rejects a stem that contains the correct answer verbatim", async () => {
    await expect(
      createQuestion(
        draft({
          stem: "Is the answer Queue to this question about ordering?",
          options: [
            { key: "A", body: "Queue" },
            { key: "B", body: "Stack" },
            { key: "C", body: "Tree" },
            { key: "D", body: "Heap" },
          ],
          correctOptionKey: "A",
        }),
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("rejects two options with identical text", async () => {
    await expect(
      createQuestion(
        draft({
          stem: "Which two options are identical here?",
          options: [
            { key: "A", body: "Same" },
            { key: "B", body: "Same" },
            { key: "C", body: "Other" },
            { key: "D", body: "Another" },
          ],
          correctOptionKey: "C",
        }),
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("rejects a correct-option key that is not among the options", async () => {
    await expect(
      createQuestion(draft({ stem: "Correct key missing here?", correctOptionKey: "E" }), ACTOR),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("rejects an EXACT duplicate, ignoring case and punctuation (§13.2)", async () => {
    await createQuestion(draft({ stem: "What does CPU stand for in computing?" }), ACTOR);

    await expect(
      createQuestion(draft({ stem: "what does cpu stand for in computing" }), ACTOR),
    ).rejects.toMatchObject({ code: "DUPLICATE" });
  });

  it("does NOT reject a merely similar question — layer 1 is exact only (§13.6)", async () => {
    await createQuestion(draft({ stem: "Which planet is closest to the Sun?" }), ACTOR);

    // Different facts, same topic: a fuzzy layer might flag this, layer 1 must not.
    const { question } = await createQuestion(
      draft({ stem: "Which planet is largest in the Solar System?" }),
      ACTOR,
    );
    expect(question.id).toBeTruthy();
  });
});

describe("updateQuestion", () => {
  it("replaces options and recomputes hashes", async () => {
    const { question } = await createQuestion(draft({ stem: "Original stem for update test?" }), ACTOR);

    await updateQuestion(
      question.id,
      {
        stem: "Replacement stem for the update test?",
        options: [
          { key: "A", body: "Alpha" },
          { key: "B", body: "Beta" },
          { key: "C", body: "Gamma" },
          { key: "D", body: "Delta" },
        ],
        correctOptionKey: "C",
      },
      ACTOR,
    );

    const loaded = await getQuestionForAdmin(question.id);
    expect(loaded.stem).toBe("Replacement stem for the update test?");
    expect(loaded.options).toHaveLength(4);
    expect(loaded.options.find((o) => o.isCorrect === 1)?.key).toBe("C");
    expect(loaded.normalizedHash).not.toBe(question.normalizedHash);
  });

  it("does not treat a question as a duplicate of itself", async () => {
    const { question } = await createQuestion(draft({ stem: "Self comparison question?" }), ACTOR);

    await expect(
      updateQuestion(question.id, { explanation: "Updated explanation." }, ACTOR),
    ).resolves.toBeTruthy();
  });
});

describe("setQuestionStatus", () => {
  it("stamps approvedBy and approvedAt on first approval", async () => {
    const { question } = await createQuestion(draft({ stem: "Approval stamping question?" }), ACTOR);
    expect(question.approvedAt).toBeNull();

    const approved = await setQuestionStatus(question.id, "approved", ACTOR);
    expect(approved.status).toBe("approved");
    expect(approved.approvedBy).toBe(ACTOR);
    expect(approved.approvedAt).not.toBeNull();

    const firstStamp = approved.approvedAt;
    const published = await setQuestionStatus(question.id, "published", ACTOR);
    expect(published.status).toBe("published");
    // Original approval time survives later transitions.
    expect(published.approvedAt).toBe(firstStamp);
  });

  it("rejects an unknown status", async () => {
    const { question } = await createQuestion(draft({ stem: "Unknown status question?" }), ACTOR);
    await expect(
      setQuestionStatus(question.id, "live" as never, ACTOR),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

// ── membership ───────────────────────────────────────────────────────────────

describe("set membership", () => {
  it("attaches questions in the CALLER's order (regression guard)", async () => {
    const created = [];
    for (const stem of [
      "Ordering test alpha question?",
      "Ordering test bravo question?",
      "Ordering test charlie question?",
      "Ordering test delta question?",
      "Ordering test echo question?",
    ]) {
      const { question } = await createQuestion(draft({ stem }), ACTOR);
      created.push(question.id);
    }

    // Deliberately shuffled relative to creation order.
    const requested = [created[2]!, created[0]!, created[4]!, created[1]!, created[3]!];
    const { added, skipped } = await attachQuestions(SET, requested, ACTOR);

    expect(added).toBe(5);
    expect(skipped).toBe(0);

    const listed = await listSetQuestions(SET);
    const listedIds = listed.filter((q) => requested.includes(q.questionId)).map((q) => q.questionId);

    // The order we asked for must be the order that comes back.
    expect(listedIds).toEqual(requested);
  });

  it("is idempotent: re-attaching adds nothing", async () => {
    const { question } = await createQuestion(draft({ stem: "Idempotent attach question?" }), ACTOR);

    const first = await attachQuestions(SET, [question.id], ACTOR);
    const second = await attachQuestions(SET, [question.id], ACTOR);

    expect(first.added).toBe(1);
    expect(second.added).toBe(0);
    expect(second.skipped).toBe(1);
  });

  it("skips unknown question ids rather than failing", async () => {
    const { question } = await createQuestion(draft({ stem: "Mixed attach question?" }), ACTOR);
    const result = await attachQuestions(SET, [question.id, "q__does_not_exist"], ACTOR);

    expect(result.added).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it("reorders a set's questions", async () => {
    const created = [];
    for (const stem of ["Reorder alpha question?", "Reorder bravo question?"]) {
      const { question } = await createQuestion(draft({ stem }), ACTOR);
      created.push(question.id);
      await attachQuestions(SET, [question.id], ACTOR);
    }

    const reversed = [created[1]!, created[0]!];
    await reorderSetQuestions(SET, reversed, ACTOR);

    const listed = await listSetQuestions(SET);
    const positions = reversed.map((id) => listed.findIndex((q) => q.questionId === id));
    expect(positions[0]).toBeLessThan(positions[1]!);
  });

  it("detaches from the set WITHOUT deleting the question", async () => {
    const { question } = await createQuestion(draft({ stem: "Detach keeps question?" }), ACTOR);
    await attachQuestions(SET, [question.id], ACTOR);

    const removed = await detachQuestions(SET, [question.id], ACTOR);
    expect(removed).toBe(1);

    const listed = await listSetQuestions(SET);
    expect(listed.some((q) => q.questionId === question.id)).toBe(false);

    // The question itself survives — it may belong to other sets.
    await expect(getQuestionForAdmin(question.id)).resolves.toBeTruthy();
  });
});

// ── search ───────────────────────────────────────────────────────────────────

describe("FTS5 search over the bank", () => {
  it("finds a question by a word from its stem", async () => {
    await createQuestion(draft({ stem: "Which creature is the Linux mascot named Tux?" }), ACTOR);

    const result = await listQuestionsForAdmin({ q: "mascot" });
    expect(result.total).toBeGreaterThan(0);
    expect(result.rows.some((r) => r.stem.includes("mascot"))).toBe(true);
  });

  it("returns nothing for a word that appears nowhere", async () => {
    const result = await listQuestionsForAdmin({ q: "zzzznotarealword" });
    expect(result.total).toBe(0);
    expect(result.rows).toHaveLength(0);
  });

  it("does not blow up on FTS syntax characters in user input", async () => {
    // A raw `*` or `"` would be a syntax error if it reached MATCH unescaped.
    const result = await listQuestionsForAdmin({ q: 'queue* "stack" (tree)' });
    expect(result).toBeTruthy();
  });
});
