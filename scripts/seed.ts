/**
 * Seed local (or remote) D1 with starter content.
 *
 *   pnpm seed              → local
 *   pnpm seed -- --remote --yes   → remote
 *
 * Idempotent by construction: every row gets a deterministic id derived from
 * its slug, and every insert is `onConflictDoNothing()`. Re-running is safe.
 *
 * NOTE (PLAN.md §2.9): this writes questions directly rather than through
 * `modules/questions.createQuestion()`. That funnel lands in M4, at which point
 * seeding routes through it like every other write path. The hashes below are
 * computed exactly as the funnel will compute them, so no data migration will
 * be needed.
 *
 * NOTE (PLAN.md §6.5): all inserts are CHUNKED. D1 rejects statements with too
 * many bound parameters, and a naive single-statement bulk insert fails with
 * "too many SQL variables". This is the concrete reason bulk content operations
 * must be paced — see §17.10.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { getPlatformProxy } from "wrangler";
import * as schema from "../src/db/schema/index";
import { computeDedupeHashes } from "../src/modules/questions/normalize";
import { simhashHex } from "../src/modules/dedupe/simhash";

// ── Types for the seed JSON ─────────────────────────────────────────────────

type SeedCategory = {
  slug: string;
  title: string;
  subtitle?: string;
  description?: string;
  icon?: string;
  accentColor?: string;
  sortOrder?: number;
  status?: string;
};

type SeedSet = {
  categorySlug: string;
  slug: string;
  title: string;
  description?: string;
  groupLabel?: string;
  mode?: string;
  difficulty?: string;
  timeLimitSeconds?: number;
  questionLimit?: number;
  sortOrder?: number;
  status?: string;
};

type SeedQuestion = {
  setSlugs: string[];
  stem: string;
  options: { key: string; body: string }[];
  correctOptionKey: string;
  explanation?: string;
  backstory?: string;
  difficulty?: string;
  topic?: string;
  tags?: string[];
  year?: number;
  examBody?: string;
  source?: string;
};

function loadJson<T>(relativePath: string): T {
  const url = new URL(relativePath, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8")) as T;
}

/**
 * Conservative bound-parameter budget. D1's ceiling is low enough that a single
 * multi-row insert of a wide table blows straight through it.
 */
const MAX_BOUND_PARAMS = 90;

async function insertChunked<T>(
  rows: T[],
  columnsPerRow: number,
  run: (chunk: T[]) => Promise<unknown>,
  label: string,
): Promise<number> {
  const perChunk = Math.max(1, Math.floor(MAX_BOUND_PARAMS / columnsPerRow));
  let written = 0;
  for (let i = 0; i < rows.length; i += perChunk) {
    const chunk = rows.slice(i, i + perChunk);
    await run(chunk);
    written += chunk.length;
    if (rows.length > perChunk) {
      console.log(`    ${label}: ${written}/${rows.length}`);
    }
  }
  return written;
}

const now = Date.now();

async function main() {
  const remote = process.argv.includes("--remote");
  if (remote && !process.argv.includes("--yes")) {
    console.error("Refusing to seed REMOTE without --yes. This writes real data.");
    process.exit(1);
  }

  const { env, dispose } = await getPlatformProxy<Cloudflare.Env>({
    configPath: "wrangler.jsonc",
    persist: { path: ".wrangler/state/v3" },
  });

  const db = drizzle(env.DB, { schema });

  const categories = loadJson<SeedCategory[]>("../seed/categories.json");
  const sets = loadJson<SeedSet[]>("../seed/sets.json");
  const questions = loadJson<SeedQuestion[]>("../seed/questions.json");

  console.log(
    `Seeding ${categories.length} categories, ${sets.length} sets, ${questions.length} questions` +
      ` → ${remote ? "REMOTE" : "local"} D1`,
  );

  // ── Categories (11 columns) ───────────────────────────────────────────────
  const categoryRows = categories.map((c) => ({
    id: `cat_${c.slug}`,
    slug: c.slug,
    title: c.title,
    subtitle: c.subtitle ?? null,
    description: c.description ?? null,
    icon: c.icon ?? null,
    accentColor: c.accentColor ?? null,
    sortOrder: c.sortOrder ?? 0,
    status: c.status ?? "published",
    createdAt: now,
    updatedAt: now,
  }));
  await insertChunked(
    categoryRows,
    11,
    (chunk) => db.insert(schema.categories).values(chunk).onConflictDoNothing(),
    "categories",
  );

  const categoryIdBySlug = new Map(categories.map((c) => [c.slug, `cat_${c.slug}`]));

  // ── Quiz sets (18 columns) ────────────────────────────────────────────────
  const setRows = sets.flatMap((s) => {
    const categoryId = categoryIdBySlug.get(s.categorySlug);
    if (!categoryId) {
      console.warn(`  ! skipping set "${s.slug}" — unknown category "${s.categorySlug}"`);
      return [];
    }
    const status = s.status ?? "published";
    return [
      {
        id: `set_${s.slug}`,
        categoryId,
        slug: s.slug,
        title: s.title,
        description: s.description ?? null,
        groupLabel: s.groupLabel ?? null,
        mode: s.mode ?? "practice",
        difficulty: s.difficulty ?? "medium",
        timeLimitSeconds: s.timeLimitSeconds ?? null,
        questionLimit: s.questionLimit ?? null,
        shuffleQuestions: 1,
        shuffleOptions: 0,
        passingPercent: null,
        sortOrder: s.sortOrder ?? 0,
        status,
        publishedAt: status === "published" ? now : null,
        createdAt: now,
        updatedAt: now,
      },
    ];
  });
  await insertChunked(
    setRows,
    18,
    (chunk) => db.insert(schema.quizSets).values(chunk).onConflictDoNothing(),
    "sets",
  );

  const setIdBySlug = new Map(sets.map((s) => [s.slug, `set_${s.slug}`]));

  // ── Questions, options and set membership ─────────────────────────────────
  let inserted = 0;
  let skippedDuplicate = 0;
  let linkCount = 0;

  for (const [index, q] of questions.entries()) {
    const optionBodies = q.options.map((o) => o.body);
    const { normalizedHash, contentHash } = await computeDedupeHashes(q.stem, optionBodies);

    // Layer-1 exact-duplicate check, mirroring what the real funnel will do.
    const existing = await db
      .select({ id: schema.questions.id })
      .from(schema.questions)
      .where(eq(schema.questions.normalizedHash, normalizedHash))
      .limit(1);

    if (existing.length > 0) {
      skippedDuplicate++;
      continue;
    }

    const questionId = `q_seed_${String(index + 1).padStart(3, "0")}`;

    await db.insert(schema.questions).values({
      id: questionId,
      stem: q.stem,
      stemFormat: "markdown",
      explanation: q.explanation ?? null,
      backstory: q.backstory ?? null,
      backstoryFormat: "markdown",
      difficulty: q.difficulty ?? "medium",
      topic: q.topic ?? null,
      tags: q.tags ? JSON.stringify(q.tags) : null,
      year: q.year ?? null,
      source: q.source ?? null,
      examBody: q.examBody ?? null,
      language: "en",
      status: "published",
      normalizedHash,
      contentHash,
      simhash: simhashHex(q.stem),
      origin: "seed",
      approvedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    // Options are inserted one question at a time: the single-correct partial
    // unique index must be evaluated per question, and 4 rows never hits the
    // bound-parameter ceiling.
    await db.insert(schema.questionOptions).values(
      q.options.map((o, optionIndex) => ({
        id: `${questionId}_${o.key}`,
        questionId,
        optionKey: o.key,
        body: o.body,
        isCorrect: o.key === q.correctOptionKey ? 1 : 0,
        sortOrder: optionIndex,
      })),
    );

    inserted++;

    const linkRows = q.setSlugs.flatMap((setSlug) => {
      const setId = setIdBySlug.get(setSlug);
      if (!setId) {
        console.warn(`  ! question ${questionId}: unknown set "${setSlug}"`);
        return [];
      }
      return [{ setId, questionId, sortOrder: 0, addedAt: now }];
    });
    await insertChunked(
      linkRows,
      4,
      (chunk) =>
        db.insert(schema.questionSetQuestions).values(chunk).onConflictDoNothing(),
      "links",
    );
    linkCount += linkRows.length;
  }

  console.log(
    `  ✓ questions inserted: ${inserted}` +
      (skippedDuplicate > 0 ? `, skipped as exact duplicates: ${skippedDuplicate}` : "") +
      `\n  ✓ set links created: ${linkCount}`,
  );

  const counts = {
    categories: (await db.select().from(schema.categories)).length,
    sets: (await db.select().from(schema.quizSets)).length,
    questions: (await db.select().from(schema.questions)).length,
    options: (await db.select().from(schema.questionOptions)).length,
  };
  console.log("  totals:", counts);

  await dispose();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
