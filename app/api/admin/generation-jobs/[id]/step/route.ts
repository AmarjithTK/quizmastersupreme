import { errorResponse, jsonResponse } from "@/lib/errors";
import { logException, logInfo } from "@/lib/logger";
import { enforceRateLimit } from "@/modules/rate-limit";
import { requireAdmin } from "@/modules/auth";
import { configuredProvider, r2RawStorage, runGenerationStep } from "@/modules/ai";
import { resolveSemanticDedupe } from "@/modules/dedupe";

/**
 * POST /api/admin/generation-jobs/:id/step — advance the job by ONE bounded step.
 *
 *   queued  → running     one model call, raw response archived to R2
 *   running → terminal    parse, validate, dedupe, store candidates
 *
 * The admin UI calls this repeatedly until `done`. Being one step per request
 * is what keeps any single request short and makes a closed browser harmless:
 * everything needed to resume is in D1 and R2.
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
      semantic: resolveSemanticDedupe(),
    };
    logInfo("route", `step ${id}`, { provider: deps.provider.name });
    const progress = await runGenerationStep(id, deps);

    logInfo("route", `step ${id} → ${progress.status}`, {
      done: progress.done,
      producedCount: progress.producedCount,
      error: progress.error,
    });
    return jsonResponse({ progress });
  } catch (error) {
    logException("route", `step failed for ${request.url}`, error);
    return errorResponse(error);
  }
}
