import { errorResponse, jsonResponse } from "@/lib/errors";
import { requireAdmin } from "@/modules/auth";
import { getJob, listJobBatches, listJobCandidates } from "@/modules/ai";

/**
 * GET /api/admin/generation-jobs/:id — job detail plus the questions it
 * produced (in batch order) and the per-batch records, so the review screen has
 * everything — what was generated and how each internal call went — in one call.
 */

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext) {
  try {
    await requireAdmin(request);
    const { id } = await context.params;

    const job = await getJob(id);
    const [candidates, batches] = await Promise.all([
      listJobCandidates(id),
      listJobBatches(id),
    ]);

    return jsonResponse({ job, candidates, batches });
  } catch (error) {
    return errorResponse(error);
  }
}
