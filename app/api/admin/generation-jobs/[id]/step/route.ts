import { errorResponse, jsonResponse } from "@/lib/errors";
import { logException, logInfo } from "@/lib/logger";
import { enforceRateLimit } from "@/modules/rate-limit";
import { requireAdmin } from "@/modules/auth";
import { configuredProvider, r2RawStorage, runGenerationStep } from "@/modules/ai";

/**
 * POST /api/admin/generation-jobs/:id/step — advance the job by ONE model round.
 *
 * Each round asks for the shortfall, auto-filters duplicates, and stores the
 * survivors; a short batch leaves the job `running` so the NEXT call tops it up
 * (up to MAX_BACKFILL_ROUNDS). The admin UI calls this until `done`, so any
 * single request stays short and a closed browser loses nothing — everything
 * needed to resume is in D1 and R2.
 *
 * Idempotent for terminal jobs, so a double-click or a retry cannot generate
 * twice.
 */

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    await requireAdmin(request);
    enforceRateLimit(request, "admin");
    const { id } = await context.params;

    const deps = {
      provider: configuredProvider(),
      storage: r2RawStorage(),
    };
    logInfo("route", `step ${id}`, { provider: deps.provider.name });
    const progress = await runGenerationStep(id, deps);

    logInfo("route", `step ${id} → ${progress.status}`, {
      done: progress.done,
      round: progress.round,
      producedCount: progress.producedCount,
      requestedCount: progress.requestedCount,
      error: progress.error,
    });
    return jsonResponse({ progress });
  } catch (error) {
    logException("route", `step failed for ${request.url}`, error);
    return errorResponse(error);
  }
}
