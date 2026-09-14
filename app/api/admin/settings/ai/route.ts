import { errorResponse, jsonResponse, validationError } from "@/lib/errors";
import { requireAdmin } from "@/modules/auth";
import {
  getAiGenerationSettings,
  updateAiGenerationSettings,
  getGenerationSettings,
  updateGenerationSettings,
  updateProviderRouting,
  getProviderRouting,
  AI_PROVIDERS,
  AI_MODEL_PRESETS,
  DEFAULT_AI_MODEL,
  GENERATION_LIMITS,
  type CountMode,
  type GenerationSettings,
} from "@/modules/settings";

/**
 * /api/admin/settings/ai
 *
 * GET  — provider + model, the generation-pipeline knobs, and provider routing.
 * PUT  — update any of them. Provider is locked to OpenRouter.
 *
 * The stored model is the DEFAULT for new generation jobs; a job can still
 * override it per run from the generate screen. The generation knobs
 * (PIPELINE-PLAN.md §13) are the global defaults — batch size is also
 * overridable per job.
 */
export async function GET() {
  try {
    const [settings, routing, generation] = await Promise.all([
      getAiGenerationSettings(),
      getProviderRouting(),
      getGenerationSettings(),
    ]);
    return jsonResponse({
      settings,
      routing,
      generation,
      generationLimits: GENERATION_LIMITS,
      providers: AI_PROVIDERS,
      modelPresets: AI_MODEL_PRESETS,
      defaultModel: DEFAULT_AI_MODEL,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const actor = await requireAdmin(request);
    const body = (await request.json()) as Record<string, unknown>;

    const generationBody =
      body.generation && typeof body.generation === "object"
        ? (body.generation as Record<string, unknown>)
        : null;

    let settings;
    let routing;
    let generation: GenerationSettings | undefined;

    try {
      settings = await updateAiGenerationSettings(
        {
          provider: typeof body.provider === "string" ? (body.provider as never) : undefined,
          model: typeof body.model === "string" ? body.model : undefined,
        },
        actor.id,
      );

      // Provider routing is optional and independent of model settings.
      routing = await updateProviderRouting(
        {
          only: Array.isArray(body.providerOnly) ? (body.providerOnly as string[]) : undefined,
          order: Array.isArray(body.providerOrder) ? (body.providerOrder as string[]) : undefined,
        },
        actor.id,
      );

      if (generationBody) {
        generation = await updateGenerationSettings(
          {
            batchSize:
              typeof generationBody.batchSize === "number" ? generationBody.batchSize : undefined,
            maxRequested:
              typeof generationBody.maxRequested === "number"
                ? generationBody.maxRequested
                : undefined,
            minRefill:
              typeof generationBody.minRefill === "number" ? generationBody.minRefill : undefined,
            maxCalls:
              typeof generationBody.maxCalls === "number" ? generationBody.maxCalls : undefined,
            countMode:
              typeof generationBody.countMode === "string"
                ? (generationBody.countMode as CountMode)
                : undefined,
          },
          actor.id,
        );
      }
    } catch (error) {
      // Settings validation throws readable Errors; surface them as 422 rather
      // than letting the generic handler turn them into "Something went wrong".
      throw validationError(error instanceof Error ? error.message : "Invalid settings.");
    }

    return jsonResponse({
      settings,
      routing,
      generation: generation ?? (await getGenerationSettings()),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
