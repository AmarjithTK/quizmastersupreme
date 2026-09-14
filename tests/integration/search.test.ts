/**
 * Search (M8) against real D1 + real FTS5.
 *
 * The headline requirement is "find a SET by the text of a QUESTION inside it",
 * so the central test asserts exactly that, plus the publication rule: search
 * must never surface a draft set.
 */

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { getPlatformProxy } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, setDbForTests } from "@/db/client";
import * as schema from "@/db/schema";
import { createQuestion } from "@/modules/questions";
import { searchSets } from "@/modules/search";

const ACTOR = "user__search_test";
const CATEGORY = "cat__search_test";
const SET_PUBLISHED = "set__search_published";
const SET_DRAFT = "set__search_draft";

let proxy: { env: { DB: D1Database }; dispose: () => Promise<void> } | null = null;

const STORY =
  "A sufficiently long backstory for the search fixture, written as prose so the validator " +
  "accepts it without complaint.";

function draft(stem: string, body = "Zephyr") {
  return {
    stem,
    options: [
      { key: "A" as const, body },
      { key: "B" as const, body: "Quartz" },
      { key: "C" as const, body: "Nimbus" },
      { key: "D" as const, body: "Onyx" },
    ],
    correctOptionKey: "A" as const,
    explanation: "Because that is the answer.",
    backstory: STORY,
    difficulty: "easy" as const,
    topic: "SearchTest",
    tags: ["search-test"],
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
      slug: "search-test",
      title: "Search Test",
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
        id: SET_PUBLISHED,
        categoryId: CATEGORY,
        slug: "search-published",
        title: "Kerala Search Published Paper",
        mode: "practice",
        difficulty: "easy",
        shuffleQuestions: 0,
        shuffleOptions: 0,
        sortOrder: 0,
        status: "published",
        publishedAt: now,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: SET_DRAFT,
        categoryId: CATEGORY,
        slug: "search-draft",
        title: "Kerala Search Draft Paper",
        mode: "practice",
        difficulty: "easy",
        shuffleQuestions: 0,
        shuffleOptions: 0,
        sortOrder: 1,
        status: "draft",
        createdAt: now,
        updatedAt: now,
      },
    ])
    .onConflictDoNothing();

  // Two questions mentioning "multics" in the published set, one in the draft.
  const published = [
    "Which organisation developed the Multics operating system?",
    "Multics introduced which file system concept?",
  ];
  for (const [index, stem] of published.entries()) {
    const { question } = await createQuestion(draft(stem), ACTOR, { status: "active" });
    await db()
      .insert(schema.questionSetQuestions)
      .values({ setId: SET_PUBLISHED, questionId: question.id, sortOrder: index, addedAt: now })
      .onConflictDoNothing();
  }

  const { question: draftQuestion } = await createQuestion(
    draft("Multics was abandoned in favour of what?"),
    ACTOR,
    { status: "active" },
  );
  await db()
    .insert(schema.questionSetQuestions)
    .values({ setId: SET_DRAFT, questionId: draftQuestion.id, sortOrder: 0, addedAt: now })
    .onConflictDoNothing();
});

afterAll(async () => {
  await cleanup();
  await proxy?.dispose();
  proxy = null;
  setDbForTests(null);
});

async function cleanup(): Promise<void> {
  for (const setId of [SET_PUBLISHED, SET_DRAFT]) {
    await db().delete(schema.quizAttempts).where(eq(schema.quizAttempts.setId, setId)).run();
    await db().delete(schema.questionSetQuestions).where(eq(schema.questionSetQuestions.setId, setId)).run();
  }
  await db().delete(schema.quizSets).where(eq(schema.quizSets.categoryId, CATEGORY)).run();
  await db().delete(schema.categories).where(eq(schema.categories.id, CATEGORY)).run();
  await db().delete(schema.categories).where(eq(schema.categories.slug, "search-test")).run();
  await db().delete(schema.questions).where(eq(schema.questions.topic, "SearchTest")).run();
}

describe("searchSets", () => {
  it("finds a SET by the text of a QUESTION inside it", async () => {
    const hits = await searchSets("multics");

    const ids = hits.map((h) => h.setId);
    expect(ids).toContain(SET_PUBLISHED);

    const hit = hits.find((h) => h.setId === SET_PUBLISHED)!;
    expect(hit.matchedCount).toBeGreaterThanOrEqual(2);
    expect(hit.matchedStems.join(" ")).toMatch(/Multics/i);
    // The subject it lives under comes back too, so the card can be linked.
    expect(hit.categoryTitle).toBe("Search Test");
  });

  it("ranks a set with more matching questions first", async () => {
    const hits = await searchSets("multics");
    const publishedIndex = hits.findIndex((h) => h.setId === SET_PUBLISHED);
    expect(publishedIndex).toBe(0);
  });

  it("NEVER returns an unpublished set", async () => {
    const hits = await searchSets("multics");
    expect(hits.map((h) => h.setId)).not.toContain(SET_DRAFT);
  });

  it("finds a set by its own title", async () => {
    const hits = await searchSets("Kerala Search Published");
    const hit = hits.find((h) => h.setId === SET_PUBLISHED);
    expect(hit).toBeTruthy();
    expect(hit!.titleMatched).toBe(true);
  });

  it("finds a set by its subject name", async () => {
    const hits = await searchSets("Search Test");
    expect(hits.map((h) => h.setId)).toContain(SET_PUBLISHED);
  });

  it("returns nothing for a query shorter than two characters", async () => {
    expect(await searchSets("a")).toEqual([]);
    expect(await searchSets("  ")).toEqual([]);
  });

  it("returns nothing for text that appears nowhere", async () => {
    expect(await searchSets("zzzznotarealword")).toEqual([]);
  });

  it("does not choke on FTS syntax characters", async () => {
    // A raw `*`, `"` or `(` reaching MATCH would be a syntax error.
    await expect(searchSets('multics* "operating" (system)')).resolves.toBeTruthy();
  });

  it("reports a question count for every hit", async () => {
    const hits = await searchSets("multics");
    for (const hit of hits) {
      expect(hit.questionCount).toBeGreaterThan(0);
    }
  });
});
