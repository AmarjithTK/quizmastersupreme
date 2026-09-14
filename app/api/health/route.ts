/**
 * Health check. Verifies the Worker is up AND that D1 is actually reachable —
 * a liveness probe that only returns 200 without touching the database would
 * hide the exact failure we most need to catch after a deploy.
 */

import { bindings } from "@/lib/cloudflare/bindings";

export const dynamic = "force-dynamic";

export async function GET() {
  const startedAt = Date.now();

  try {
    const row = await bindings().DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
    return Response.json(
      {
        status: "ok",
        database: row?.ok === 1 ? "ok" : "unexpected-response",
        environment: bindings().APP_ENV,
        latencyMs: Date.now() - startedAt,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return Response.json(
      {
        status: "degraded",
        database: "unreachable",
        message: error instanceof Error ? error.message : String(error),
        latencyMs: Date.now() - startedAt,
      },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
