import { errorResponse, jsonResponse } from "@/lib/errors";
import { logInfo } from "@/lib/logger";
import { bindings } from "@/lib/cloudflare/bindings";
import { requireAdmin } from "@/modules/auth";
import { createGenerationJob, listJobs, openRouterKeyConfigured } from "@/modules/ai";
import { getAiGenerationSettings, getProviderRouting } from "@/modules/settings";

/**
 * /api/admin/generation-jobs
 *
 * GET  — recent jobs, plus whether the provider is actually configured.
 * POST — create a job in `queued`. This does NOT call the model: the caller
 *        then advances it with `/step`, so no single request owns the whole
 *        job (§2.8).
 */

export async function GET(request: Request) {
  try {
    await requireAdmin(request);
    const jobs = await listJobs(30);
    return jsonResponse({
      jobs,
      configured: openRouterKeyConfigured(),
      defaultModel: bindings().DEFAULT_GENERATION_MODEL,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requireAdmin(request);
    const body = (await request.json()) as Record<string, unknown>;

    // Model: explicit per-job override wins, else the admin-stored default,
    // else the baked-in default (PLAN.md §12 / settings).
    const aiSettings = await getAiGenerationSettings();
    const model =
      typeof body.model === "string" && body.model.trim()
        ? body.model.trim()
        : aiSettings.model;

    // Provider routing (only/order) comes from settings; per-job overrides
    // are not offered — routing is an account-wide cost lever, not a per-batch
    // experiment.
    const routing = await getProviderRouting();

    const job = await createGenerationJob(
      {
        topic: typeof body.topic === "string" ? body.topic : "",
        brief: typeof body.brief === "string" ? body.brief : "",
        requestedCount: typeof body.requestedCount === "number" ? body.requestedCount : 10,
        difficulty: typeof body.difficulty === "string" ? body.difficulty : null,
        subtopics: Array.isArray(body.subtopics)
          ? body.subtopics.filter((s): s is string => typeof s === "string")
          : null,
        avoidTopics: Array.isArray(body.avoidTopics)
          ? body.avoidTopics.filter((s): s is string => typeof s === "string")
          : null,
        model,
        target: typeof body.target === "string" ? body.target : null,
        sources: typeof body.sources === "string" ? body.sources : null,
        providerOnly: routing.only.length > 0 ? routing.only : null,
        providerOrder: routing.order.length > 0 ? routing.order : null,
        targetCategoryId: typeof body.targetCategoryId === "string" ? body.targetCategoryId : null,
        targetSetId: typeof body.targetSetId === "string" ? body.targetSetId : null,
      },
      actor.id,
    );

    logInfo("route", `job ${job.id} created by admin ${actor.id}`, {
      topic: job.topic,
      model: job.model,
      hasTarget: Boolean(job.target),
      hasSources: Boolean(job.sources),
    });
    return jsonResponse({ job }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
