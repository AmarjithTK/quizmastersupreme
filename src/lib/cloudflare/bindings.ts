/**
 * Cloudflare binding access.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS IS THE ONLY FILE IN THE CODEBASE THAT MAY IMPORT `cloudflare:workers`.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * PLAN.md §2.7. Everything else calls `bindings()`. This is the escape hatch
 * that makes the vinext → OpenNext migration a one-file change: OpenNext
 * exposes the same values via `getCloudflareContext().env` instead.
 *
 * Binding types come from worker-configuration.d.ts, which `wrangler types`
 * regenerates from wrangler.jsonc. Re-run it after editing that file:
 *   pnpm wrangler types
 */

import { env } from "cloudflare:workers";

/** Exactly the bindings declared in wrangler.jsonc. */
export type Bindings = Cloudflare.Env;

export function bindings(): Bindings {
  // `env` is populated per-request by the Workers runtime. Its generated type
  // is structurally correct, so the cast is only to pin the name.
  return env as unknown as Bindings;
}

/** True when running under `vinext dev` / `wrangler dev` rather than production. */
export function isDev(): boolean {
  // Widened to string: `wrangler types` narrows APP_ENV to its literal default
  // value ("development"), which makes a direct === "production" comparison a
  // compile error even though the runtime value varies per environment.
  return (bindings().APP_ENV as string) !== "production";
}
