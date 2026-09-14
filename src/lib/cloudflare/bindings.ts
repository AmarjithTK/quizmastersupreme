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
export type GeneratedEnv = Cloudflare.Env;

/**
 * Runtime bindings `wrangler types` cannot see.
 *
 * Secrets arrive via `.dev.vars` locally and `wrangler secret put` in
 * production — never via `vars` (those are readable in the dashboard). They
 * exist at runtime but not in the generated `Env` type, so they are declared
 * here and merged.
 */
export interface Bindings extends GeneratedEnv {
  GOOGLE_CLIENT_SECRET: string;
  SESSION_SECRET: string;
  /** OpenRouter key for AI question generation (M10). */
  OPENROUTER_API_KEY: string;
}

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
