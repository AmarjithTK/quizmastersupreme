/**
 * Opens an isolated local D1 for tests.
 *
 * Deliberately NOT the dev database: `.tooling/test-state` is a separate
 * persist directory, so a test run can never corrupt seeded dev content.
 * `pnpm pretest` applies migrations there before the suite runs.
 */

import { getPlatformProxy } from "wrangler";
import { TEST_PERSIST_PATH } from "../global-setup";

export { TEST_PERSIST_PATH };

export type TestD1 = {
  env: { DB: D1Database };
  dispose: () => Promise<void>;
};

export async function openTestDb(): Promise<TestD1> {
  const proxy = await getPlatformProxy<{ DB: D1Database }>({
    configPath: "wrangler.jsonc",
    persist: { path: TEST_PERSIST_PATH },
  });
  return { env: proxy.env as { DB: D1Database }, dispose: proxy.dispose };
}

export async function allRows<T = Record<string, unknown>>(
  db: D1Database,
  sql: string,
  ...binds: unknown[]
): Promise<T[]> {
  const statement = db.prepare(sql);
  const bound = binds.length > 0 ? statement.bind(...binds) : statement;
  const result = await bound.all<T>();
  return result.results ?? [];
}

/** Returns the SQLite error message if the statement is rejected, else null. */
export async function expectRejected(
  db: D1Database,
  sql: string,
  ...binds: unknown[]
): Promise<string | null> {
  try {
    await db
      .prepare(sql)
      .bind(...binds)
      .run();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
