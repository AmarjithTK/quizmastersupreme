/**
 * `pnpm backup` — dump the local D1 to .tooling/backups/backup-<ts>.json
 *
 * Uses `getPlatformProxy` (a real local D1), the same way the dev server does.
 * The file is pure JSON of the `qms-backup` format, so it can be moved to R2
 * in production; `pnpm restore --file <path>` reads it back.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exportDatabase } from "../src/modules/backup";

const proxy = await getPlatformProxyForScript();
const { drizzle } = await import("drizzle-orm/d1");
const database = drizzle(proxy.env.DB, { schema: await import("../src/db/schema") });

const payload = await exportDatabase(database);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const dir = join(process.cwd(), ".tooling", "backups");
mkdirSync(dir, { recursive: true });
const file = join(dir, `backup-${stamp}.json`);
writeFileSync(file, JSON.stringify(payload, null, 2));

const counts = Object.entries(payload.tables)
  .map(([t, rows]) => `${t}=${rows.length}`)
  .join(" ");
console.log(`backup written: ${file}`);
console.log(`row counts: ${counts}`);
await proxy.dispose();

async function getPlatformProxyForScript(): Promise<{ env: { DB: D1Database }; dispose: () => Promise<void> }> {
  const { getPlatformProxy } = await import("wrangler");
  return getPlatformProxy<{ DB: D1Database }>({
    configPath: "wrangler.jsonc",
    persist: { path: ".wrangler/state/v3" },
  });
}