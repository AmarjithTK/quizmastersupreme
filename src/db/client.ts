/**
 * Drizzle client over the D1 binding.
 *
 * One function, no module-level singleton: a Worker isolate can serve many
 * requests, and `env` is resolved per request, so we build the client lazily
 * rather than caching it at import time.
 */

import { drizzle } from "drizzle-orm/d1";
import { bindings } from "@/lib/cloudflare/bindings";
import * as schema from "./schema";

export function db() {
  return drizzle(bindings().DB, { schema });
}

export type Database = ReturnType<typeof db>;

export { schema };
export * from "./schema";
