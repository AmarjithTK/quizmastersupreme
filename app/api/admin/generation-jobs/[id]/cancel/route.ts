import { errorResponse, jsonResponse } from "@/lib/errors";
import { requireAdmin } from "@/modules/auth";
import { cancelJob } from "@/modules/ai";

/** POST /api/admin/generation-jobs/:id/cancel */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireAdmin(request);
    const { id } = await context.params;
    return jsonResponse({ job: await cancelJob(id, actor.id) });
  } catch (error) {
    return errorResponse(error);
  }
}
