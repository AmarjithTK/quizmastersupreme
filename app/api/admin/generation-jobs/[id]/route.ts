import { errorResponse, jsonResponse } from "@/lib/errors";
import { requireAdmin } from "@/modules/auth";
import { workflowConfigured } from "@/modules/ai/orchestration";
import {
  getJob,
  listGenerationSegments,
  listJobBatches,
  listJobCandidates,
  listJobRejections,
  listJobSourceFacts,
} from "@/modules/ai";

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
    const [candidates, batches, segments, sourceFacts, rejections] = await Promise.all([
      listJobCandidates(id),
      listJobBatches(id),
      listGenerationSegments(id, job.planRevision),
      listJobSourceFacts(id),
      listJobRejections(id),
    ]);

    return jsonResponse({ job, candidates, batches, segments, sourceFacts, rejections,
      orchestration: workflowConfigured() ? "workflow" : "manual" });
  } catch (error) {
    return errorResponse(error);
  }
}
