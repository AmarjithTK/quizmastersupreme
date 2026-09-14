/**
 * Rebuild the FTS5 index from the `questions` table.
 *
 * The triggers in migrations/0001_fts5.sql keep the index in sync on every
 * normal insert/update/delete. This script is the repair path for when they
 * are bypassed — a bulk import with triggers disabled, a restored backup, or a
 * schema change to the FTS columns.
 *
 *   pnpm reindex:fts              → local
 *   pnpm reindex:fts -- --remote  → remote
 *
 * Safe to run at any time: it is idempotent and non-destructive to `questions`.
 */

import { getPlatformProxy } from "wrangler";

async function main() {
  const remote = process.argv.includes("--remote");
  if (remote && !process.argv.includes("--yes")) {
    console.error("Refusing to reindex REMOTE without --yes.");
    process.exit(1);
  }

  const { env, dispose } = await getPlatformProxy<Cloudflare.Env>({
    configPath: "wrangler.jsonc",
    // Matches what `wrangler d1` uses for local state.
    persist: { path: ".wrangler/state/v3" },
  });

  const db = env.DB;

  const before = await db.prepare(`SELECT COUNT(*) AS n FROM questions_fts`).first<{ n: number }>();

  // Clear, then repopulate from the source of truth. `questions` is authoritative
  // (PLAN.md §2.3) — the index is derived data and can always be rebuilt.
  await db.prepare(`DELETE FROM questions_fts`).run();
  await db
    .prepare(
      `INSERT INTO questions_fts (question_id, stem, explanation, topic, tags)
       SELECT id, stem, COALESCE(explanation, ''), COALESCE(topic, ''), COALESCE(tags, '')
       FROM questions`,
    )
    .run();

  const after = await db.prepare(`SELECT COUNT(*) AS n FROM questions_fts`).first<{ n: number }>();
  const questions = await db.prepare(`SELECT COUNT(*) AS n FROM questions`).first<{ n: number }>();

  console.log(
    `Reindexed ${remote ? "REMOTE" : "local"} FTS5: ${before?.n ?? 0} → ${after?.n ?? 0} rows ` +
      `(${questions?.n ?? 0} questions in the bank)`,
  );

  if ((after?.n ?? 0) !== (questions?.n ?? 0)) {
    console.warn("  ! FTS row count does not match the question count — investigate.");
  }

  await dispose();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
