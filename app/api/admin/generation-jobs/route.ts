import { errorResponse, jsonResponse } from "@/lib/errors";
import { logInfo } from "@/lib/logger";
import { bindings } from "@/lib/cloudflare/bindings";
import { requireAdmin } from "@/modules/auth";
import { createGenerationJob, listJobs, openRouterKeyConfigured } from "@/modules/ai";
import { dispatchGenerationWorkflow } from "@/modules/ai/orchestration";
import {
  getAiGenerationSettings,
  getGenerationSettings,
  getProviderRouting,
} from "@/modules/settings";
import { z } from "zod";
import { validationError } from "@/lib/errors";

const CreateJobSchema = z.object({
  topic: z.string().min(1).max(240),
  brief: z.string().min(1).max(8_000),
  requestedCount: z.number().int().min(1),
  batchSize: z.number().int().min(5).max(50).nullable().optional(),
  groundingMode: z.enum(["off", "single"]).nullable().optional(),
  difficulty: z.string().max(40).nullable().optional(),
  subtopics: z.array(z.string().min(1).max(240)).max(40).nullable().optional(),
  avoidTopics: z.array(z.string().min(1).max(240)).max(40).nullable().optional(),
  model: z.string().max(240).optional(),
  target: z.string().max(1_000).nullable().optional(),
  sources: z.string().max(20_000).nullable().optional(),
  targetCategoryId: z.string().max(100).nullable().optional(),
  targetSetId: z.string().max(100).nullable().optional(),
}).strict();

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
    const [generation, ai] = await Promise.all([
      getGenerationSettings(),
      getAiGenerationSettings(),
    ]);
    return jsonResponse({
      jobs,
      configured: openRouterKeyConfigured(),
      defaultModel: bindings().DEFAULT_GENERATION_MODEL || ai.model,
      generation,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requireAdmin(request);
    const parsed = CreateJobSchema.safeParse(await request.json());
    if (!parsed.success) throw validationError(parsed.error.issues[0]?.message ?? "Invalid generation request.");
    const body = parsed.data;

    // Model: explicit per-job override wins, else the admin-stored default,
    // else the baked-in default (PLAN.md §12 / settings).
    const aiSettings = await getAiGenerationSettings();
    const model =
      body.model?.trim()
        ? body.model.trim()
        : aiSettings.model;

    // Provider routing (only/order) comes from settings; per-job overrides
    // are not offered — routing is an account-wide cost lever, not a per-batch
    // experiment.
    const routing = await getProviderRouting();

    const job = await createGenerationJob(
      {
        topic: body.topic,
        brief: body.brief,
        requestedCount: body.requestedCount,
        // Per-job batch size; falls back to the admin default in createGenerationJob.
        batchSize: body.batchSize ?? null,
        // Per-job grounding override; null = use the global setting.
        groundingMode:
          body.groundingMode ?? null,
        difficulty: body.difficulty ?? null,
        subtopics: body.subtopics ?? null,
        avoidTopics: body.avoidTopics ?? null,
        model,
        target: body.target ?? null,
        sources: body.sources ?? null,
        providerOnly: routing.only.length > 0 ? routing.only : null,
        providerOrder: routing.order.length > 0 ? routing.order : null,
        targetCategoryId: body.targetCategoryId ?? null,
        targetSetId: body.targetSetId ?? null,
        planningEnabled: true,
      },
      actor.id,
    );

    logInfo("route", `job ${job.id} created by admin ${actor.id}`, {
      topic: job.topic,
      model: job.model,
      requested: job.requestedCount,
      batchSize: job.batchSize,
      maxCalls: job.maxCalls,
      hasTarget: Boolean(job.target),
      hasSources: Boolean(job.sources),
    });
    const scheduled = await dispatchGenerationWorkflow("start", job.id);
    return jsonResponse({
      job,
      orchestration: scheduled ? "workflow" : "manual",
      ...(scheduled ? {} : { orchestrationWarning: "Automatic scheduling is unavailable; use the browser's recoverable manual loop." }),
    }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
