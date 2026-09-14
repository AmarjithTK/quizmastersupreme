import { errorResponse, jsonResponse } from "@/lib/errors";
import { requireAdmin } from "@/modules/auth";
import { getJob, listJobCandidates } from "@/modules/ai";

/**
 * GET /api/admin/generation-jobs/:id — job detail plus the questions it
 * produced (in batch order), so the review screen has everything in one call.
 */

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext) {
  try {
    await requireAdmin(request);
    const { id } = await context.params;

    const job = await getJob(id);
    const candidates = await listJobCandidates(id);

    return jsonResponse({ job, candidates });
  } catch (error) {
    return errorResponse(error);
  }
}
