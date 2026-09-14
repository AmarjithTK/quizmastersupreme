/**
 * LOCAL DEV ONLY — mint an admin session cookie without going through Google.
 *
 *   pnpm dev:admin-token [email]
 *
 * Prints a ready-to-paste `Cookie:` header for curling the admin API.
 *
 * WHY THIS IS SAFE TO KEEP IN THE REPO: it runs on Node through
 * `getPlatformProxy`, which only ever touches the LOCAL D1 under
 * `.wrangler/state`. There is no `wrangler` dependency inside a deployed
 * Worker, so this file cannot execute in production even if it were bundled.
 * It also refuses to run if APP_ENV is not `development`.
 */

import { getPlatformProxy } from "wrangler";
import { randomToken, sha256Hex } from "../src/lib/crypto";

const LOCAL_PERSIST_PATH = ".wrangler/state/v3";

async function main() {
  const email = (process.argv[2] ?? "dev-admin@localhost").toLowerCase();

  const { env, dispose } = await getPlatformProxy<{
    DB: D1Database;
    APP_ENV?: string;
  }>({
    configPath: "wrangler.jsonc",
    persist: { path: LOCAL_PERSIST_PATH },
  });

  if (env.APP_ENV && env.APP_ENV !== "development") {
    console.error(`Refusing to mint a dev token: APP_ENV is "${env.APP_ENV}", not development.`);
    process.exit(1);
  }

  const now = Date.now();
  const userId = `user_dev_${email.replace(/[^a-z0-9]/g, "_")}`;

  await env.DB.prepare(
    `INSERT INTO users (id, email, email_norm, display_name, role, status, auth_provider,
                        email_verified, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'admin', 'active', 'google', 1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET role = 'admin', status = 'active', updated_at = excluded.updated_at`,
  )
    .bind(userId, email, email, "Dev Admin", now, now)
    .run();

  const rawToken = randomToken(32);
  await env.DB.prepare(
    `INSERT INTO auth_sessions (id, user_id, expires_at, last_seen_at, user_agent, created_at)
     VALUES (?, ?, ?, ?, 'dev-admin-token script', ?)`,
  )
    .bind(await sha256Hex(rawToken), userId, now + 24 * 60 * 60 * 1000, now, now)
    .run();

  await dispose();

  console.log(`\nAdmin session minted for ${email} (local D1 only, valid 24h)\n`);
  console.log(`Cookie: qms_session=${rawToken}\n`);
  console.log("Example:");
  console.log(`  curl -s -H "Cookie: qms_session=${rawToken}" http://localhost:3000/api/admin/sets\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
