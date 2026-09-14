/**
 * Vitest global setup: build a clean local D1 from the REAL migration files.
 *
 * Why not `wrangler d1 migrations apply --persist-to`? Because the Wrangler CLI
 * resolves `--persist-to X` to `X/v3/...` while `getPlatformProxy({ persist: {
 * path: X } })` resolves to `X/...`. They silently point at different SQLite
 * files, so the tests would open an empty database.
 *
 * Applying the migration files directly removes that whole class of confusion
 * AND means the tests exercise the exact SQL that ships to production —
 * including the FTS5 virtual table and its triggers, which Wrangler's own
 * migration runner is not otherwise covered for here.
 */

import { readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getPlatformProxy } from "wrangler";

export const TEST_PERSIST_PATH = ".tooling/test-state";
const MIGRATIONS_DIR = "migrations";

/** Drizzle separates statements with this marker; it is safe inside triggers. */
const BREAKPOINT = "--> statement-breakpoint";

export default async function globalSetup() {
  rmSync(TEST_PERSIST_PATH, { recursive: true, force: true });

  const proxy = await getPlatformProxy<{ DB: D1Database }>({
    configPath: "wrangler.jsonc",
    persist: { path: TEST_PERSIST_PATH },
  });

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  let statements = 0;
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    for (const chunk of sql.split(BREAKPOINT)) {
      const statement = chunk.trim();
      if (statement.length === 0) continue;
      await proxy.env.DB.prepare(statement).run();
      statements++;
    }
  }

  await proxy.dispose();

  console.log(`\n[test-setup] applied ${files.length} migrations (${statements} statements)\n`);
}
