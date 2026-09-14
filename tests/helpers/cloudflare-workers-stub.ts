/**
 * Vitest-only stand-in for the `cloudflare:workers` module.
 *
 * `cloudflare:workers` only exists inside the Workers runtime, so importing it
 * under plain Node crashes at module load — even if the caller never touches
 * bindings. This stub lets the auth module be imported in tests; the Proxy
 * throws a clear message the moment ANY code actually calls bindings() in a
 * test, which is never supposed to happen (tests use `setDbForTests`).
 *
 * TypeScript types still come from worker-configuration.d.ts; this file is
 * runtime-only and is mapped onto the bare specifier by vitest.config.ts.
 */

export const env: unknown = new Proxy(
  {},
  {
    get() {
      throw new Error(
        "bindings() was called in a Node test. Use setDbForTests() from " +
          "@/db/client to point services at a real local D1 instead.",
      );
    },
  },
);