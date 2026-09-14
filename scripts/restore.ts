/**
 * `pnpm restore --file <path>` — wipe the local D1 and restore a backup file.
 *
 * DESTRUCTIVE: every current row is deleted first. The rehearsal exit test and
 * this script share `importDatabase`, so "restore works" is a tested claim.
 */

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { importDatabase, type BackupPayload } from "../src/modules/backup";

const { values } = parseArgs({ options: { file: { type: "string" } } });
if (!values.file) {
  console.error("usage: pnpm restore --file .tooling/backups/backup-<ts>.json");
  process.exit(1);
}

const { getPlatformProxy } = await import("wrangler");
const proxy = await getPlatformProxy<{ DB: D1Database }>({
  configPath: "wrangler.jsonc",
  persist: { path: ".wrangler/state/v3" },
});
const { drizzle } = await import("drizzle-orm/d1");
const schema = await import("../src/db/schema");
const database = drizzle(proxy.env.DB, { schema });

const payload = JSON.parse(readFileSync(values.file, "utf8")) as BackupPayload;
const { restored } = await importDatabase(database, payload);

console.log("restore complete — rows per table:");
for (const [table, count] of Object.entries(restored)) {
  console.log(`  ${table}: ${count}`);
}
await proxy.dispose();