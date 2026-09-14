import type { Config } from "drizzle-kit";

/**
 * drizzle-kit generates plain SQLite SQL into ./migrations.
 *
 * Migrations are applied with Wrangler, not drizzle-kit:
 *   pnpm db:migrate:local    → wrangler d1 migrations apply --local
 *   pnpm db:migrate:remote   → wrangler d1 migrations apply --remote
 *
 * That keeps ONE migration path for local and production, and lets us add
 * hand-written migrations that drizzle-kit cannot model — notably the FTS5
 * virtual table and its triggers (PLAN.md §6.3).
 *
 * Migrations are APPEND-ONLY. Never edit an applied migration.
 */
export default {
  schema: "./src/db/schema/index.ts",
  out: "./migrations",
  dialect: "sqlite",
} satisfies Config;
