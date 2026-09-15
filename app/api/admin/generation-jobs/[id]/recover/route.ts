import { errorResponse, jsonResponse } from "@/lib/errors";
import { enforceRateLimit } from "@/modules/rate-limit";
import { requireAdmin } from "@/modules/auth";
import { configuredProvider, r2RawStorage, runGenerationStep } from "@/modules/ai";
import { dispatchGenerationWorkflow } from "@/modules/ai/orchestration";

type RouteContext = { params: Promise<{ id: string }> };

/** `/step` owns stale-lease recovery; this explicit endpoint makes that action discoverable. */
export async function POST(request: Request, context: RouteContext) {
  try {
    await requireAdmin(request);
    enforceRateLimit(request, "admin");
    const { id } = await context.params;
    if (await dispatchGenerationWorkflow("recover", id)) {
      return jsonResponse({ orchestration: "workflow", jobId: id });
    }
    const progress = await runGenerationStep(id, {
      provider: configuredProvider(),
      storage: r2RawStorage(),
    });
    return jsonResponse({ progress });
  } catch (error) {
    return errorResponse(error);
  }
}
