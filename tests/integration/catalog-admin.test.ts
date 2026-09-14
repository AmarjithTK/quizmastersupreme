/**
 * Catalog admin invariants (M3) against real D1.
 *
 * These guard the DOMAIN rules, not the HTTP layer: per-category slug
 * uniqueness, time-limit bounds, publish stamping, and archive semantics.
 * The route handlers only coerce input; the logic under test here is what
 * actually protects the data.
 */

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { getPlatformProxy } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, setDbForTests } from "@/db/client";
import * as schema from "@/db/schema";
import { ApiError } from "@/lib/errors";
import {
  archiveCategory,
  archiveSet,
  createCategory,
  createSet,
  updateSet,
} from "@/modules/catalog";

const ACTOR = "user__catalog_admin_test";
const CATEGORY_A = "cat__setadmin_a";
const CATEGORY_B = "cat__setadmin_b";

let proxy: { env: { DB: D1Database }; dispose: () => Promise<void> } | null = null;

/** Attach a fresh local D1 to the domain services (no Workers runtime). */
beforeAll(async () => {
  proxy = await getPlatformProxy<{ DB: D1Database }>({
    configPath: "wrangler.jsonc",
    persist: { path: ".tooling/test-state" },
  });
  setDbForTests(drizzle(proxy.env.DB, { schema }));

  await cleanup();

  // Insert the fixtures directly so the ids are deterministic — the tests below
  // address categories by a fixed id.
  const now = Date.now();
  await db()
    .insert(schema.categories)
    .values([
      { id: CATEGORY_A, slug: "setadmin-a", title: "SetAdmin A", sortOrder: 0, status: "published", createdAt: now, updatedAt: now },
      { id: CATEGORY_B, slug: "setadmin-b", title: "SetAdmin B", sortOrder: 1, status: "published", createdAt: now, updatedAt: now },
    ])
    .onConflictDoNothing();
});

afterAll(async () => {
  await cleanup();
  await proxy?.dispose();
  proxy = null;
  setDbForTests(null);
});

async function cleanup(): Promise<void> {
  for (const id of [CATEGORY_A, CATEGORY_B]) {
    await db().delete(schema.quizSets).where(eq(schema.quizSets.categoryId, id)).run();
    await db().delete(schema.categories).where(eq(schema.categories.id, id)).run();
  }
  // Slugs are unique and could linger if a run died mid-setup.
  await db().delete(schema.categories).where(eq(schema.categories.slug, "setadmin-a")).run();
  await db().delete(schema.categories).where(eq(schema.categories.slug, "setadmin-b")).run();
}

// ─────────────────────────────────────────────────────────────────────────────

describe("createSet validation", () => {
  it("rejects a category that does not exist", async () => {
    await expect(
      createSet({ categoryId: "cat__nope", title: "Ghost set" }, ACTOR),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it("defaults to a draft with no publish date and shuffled questions", async () => {
    const set = await createSet({ categoryId: CATEGORY_A, title: "Draft Set" }, ACTOR);

    expect(set.status).toBe("draft");
    expect(set.publishedAt).toBeNull();
    expect(set.shuffleQuestions).toBe(1);
    expect(set.shuffleOptions).toBe(0);
    expect(set.slug).toBe("draft-set"); // slugified from the title
  });

  it("rejects a duplicate slug within the same category", async () => {
    await createSet({ categoryId: CATEGORY_A, title: "Unique Title", slug: "shared-slug" }, ACTOR);

    await expect(
      createSet({ categoryId: CATEGORY_A, title: "Another", slug: "shared-slug" }, ACTOR),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("ALLOWS the same slug in a different category", async () => {
    // (category_id, slug) is the uniqueness key — this is the rule that makes
    // "Mock Set 1" possible in every subject without ugly prefixes.
    const a = await createSet({ categoryId: CATEGORY_A, title: "A", slug: "mock-set-1" }, ACTOR);
    const b = await createSet({ categoryId: CATEGORY_B, title: "B", slug: "mock-set-1" }, ACTOR);

    expect(a.slug).toBe("mock-set-1");
    expect(b.slug).toBe("mock-set-1");
    expect(a.id).not.toBe(b.id);
  });

  it("rejects out-of-range time limits but accepts null (untimed)", async () => {
    await expect(
      createSet({ categoryId: CATEGORY_A, title: "Too short", timeLimitSeconds: 10 }, ACTOR),
    ).rejects.toMatchObject({ code: "VALIDATION" });

    await expect(
      createSet({ categoryId: CATEGORY_A, title: "Too long", timeLimitSeconds: 99_999 }, ACTOR),
    ).rejects.toMatchObject({ code: "VALIDATION" });

    const untimed = await createSet(
      { categoryId: CATEGORY_A, title: "Untimed", timeLimitSeconds: null },
      ACTOR,
    );
    expect(untimed.timeLimitSeconds).toBeNull();
  });

  it("rejects an unknown mode or difficulty", async () => {
    // Deliberately bypass the TS unions: the point is that a bad value arriving
    // from HTTP (which is untyped) is still rejected by the domain layer.
    const badMode = {
      categoryId: CATEGORY_A,
      title: "Bad mode",
      mode: "exam",
    } as unknown as Parameters<typeof createSet>[0];
    await expect(createSet(badMode, ACTOR)).rejects.toMatchObject({ code: "VALIDATION" });

    await expect(
      createSet({ categoryId: CATEGORY_A, title: "Bad diff", difficulty: "impossible" }, ACTOR),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("rejects a passing percentage outside 0–100", async () => {
    await expect(
      createSet({ categoryId: CATEGORY_A, title: "Bad pass", passingPercent: 150 }, ACTOR),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

describe("updateSet", () => {
  it("stamps publishedAt on first publish and preserves it afterwards", async () => {
    const set = await createSet({ categoryId: CATEGORY_A, title: "Publish Me" }, ACTOR);
    expect(set.publishedAt).toBeNull();

    const published = await updateSet(set.id, { status: "published" }, ACTOR);
    expect(published.status).toBe("published");
    expect(published.publishedAt).not.toBeNull();
    const firstStamp = published.publishedAt;

    // Unpublish and republish: the original publication date must survive.
    await updateSet(set.id, { status: "draft" }, ACTOR);
    const republished = await updateSet(set.id, { status: "published" }, ACTOR);
    expect(republished.publishedAt).toBe(firstStamp);
  });

  it("rejects a slug that collides with a sibling set", async () => {
    const one = await createSet({ categoryId: CATEGORY_A, title: "One", slug: "sibling-one" }, ACTOR);
    await createSet({ categoryId: CATEGORY_A, title: "Two", slug: "sibling-two" }, ACTOR);

    await expect(updateSet(one.id, { slug: "sibling-two" }, ACTOR)).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("rejects an invalid status", async () => {
    const set = await createSet({ categoryId: CATEGORY_A, title: "Status Check" }, ACTOR);
    const badStatus = { status: "live" } as unknown as Parameters<typeof updateSet>[1];
    await expect(updateSet(set.id, badStatus, ACTOR)).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });
});

describe("archive semantics", () => {
  it("archives rather than deletes a set, keeping the row", async () => {
    const set = await createSet({ categoryId: CATEGORY_A, title: "Archive Me" }, ACTOR);
    const archived = await archiveSet(set.id, ACTOR);

    expect(archived.status).toBe("archived");

    const stillThere = await db()
      .select()
      .from(schema.quizSets)
      .where(eq(schema.quizSets.id, set.id));
    expect(stillThere).toHaveLength(1);
  });

  it("archives rather than deletes a category, keeping its sets", async () => {
    await createSet({ categoryId: CATEGORY_B, title: "Survivor" }, ACTOR);
    await archiveCategory(CATEGORY_B, ACTOR);

    const category = (
      await db().select().from(schema.categories).where(eq(schema.categories.id, CATEGORY_B))
    )[0];
    expect(category?.status).toBe("archived");

    const sets = await db()
      .select()
      .from(schema.quizSets)
      .where(eq(schema.quizSets.categoryId, CATEGORY_B));
    expect(sets.length).toBeGreaterThan(0);
  });
});
