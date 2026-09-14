import { errorResponse, jsonResponse } from "@/lib/errors";
import { requireAdmin } from "@/modules/auth";
import {
  getAiGenerationSettings,
  updateAiGenerationSettings,
  getProviderRouting,
  updateProviderRouting,
  AI_PROVIDERS,
  AI_MODEL_PRESETS,
  DEFAULT_AI_MODEL,
} from "@/modules/settings";

/**
 * /api/admin/settings/ai
 *
 * GET  — current generation provider + model (and the choices offered).
 * PUT  — update provider and/or model. Provider is locked to OpenRouter.
 *
 * The stored model is the DEFAULT for new generation jobs; a job can still
 * override it per run from the generate screen.
 */
export async function GET() {
  try {
    const settings = await getAiGenerationSettings();
    const routing = await getProviderRouting();
    return jsonResponse({
      settings,
      routing,
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

    const settings = await updateAiGenerationSettings(
      {
        provider: typeof body.provider === "string" ? (body.provider as never) : undefined,
        model: typeof body.model === "string" ? body.model : undefined,
      },
      actor.id,
    );

    // Provider routing is optional and independent of model settings.
    const routing = await updateProviderRouting(
      {
        only: Array.isArray(body.providerOnly) ? (body.providerOnly as string[]) : undefined,
        order: Array.isArray(body.providerOrder) ? (body.providerOrder as string[]) : undefined,
      },
      actor.id,
    );

    return jsonResponse({ settings, routing });
  } catch (error) {
    return errorResponse(error);
  }
}