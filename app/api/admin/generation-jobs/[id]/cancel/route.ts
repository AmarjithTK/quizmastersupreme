import { errorResponse, jsonResponse } from "@/lib/errors";
import { requireAdmin } from "@/modules/auth";
import { cancelJob } from "@/modules/ai";
import { dispatchGenerationWorkflow } from "@/modules/ai/orchestration";

/** POST /api/admin/generation-jobs/:id/cancel */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireAdmin(request);
    const { id } = await context.params;
    const job = await cancelJob(id, actor.id);
    await dispatchGenerationWorkflow("cancel", id);
    return jsonResponse({ job });
  } catch (error) {
    return errorResponse(error);
  }
}
