/**
 * Drizzle client over the D1 binding.
 *
 * One function, no module-level singleton that outlives a request: a Worker
 * isolate can serve many requests and `env` is resolved per request, so the
 * client is built lazily.
 *
 * The `setDbForTests` seam is the ONLY path that bypasses `bindings()`. It is
 * null in production; integration tests point it at a real local D1 so domain
 * services can be exercised without the Workers runtime (which `cloudflare:workers`
 * imports require). The production code path is untouched.
 */

import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { bindings } from "@/lib/cloudflare/bindings";
import * as schema from "./schema";

export type Database = DrizzleD1Database<typeof schema>;

let testOverride: Database | null = null;

/** Test-only seam. Passing null restores the real binding-backed client. */
export function setDbForTests(database: Database | null): void {
  testOverride = database;
}

export function db(): Database {
  return testOverride ?? drizzle(bindings().DB, { schema });
}

export { schema };
export * from "./schema";