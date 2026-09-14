import { errorResponse, jsonResponse } from "@/lib/errors";
import { requireAdmin } from "@/modules/auth";
import { listCandidates, pendingReviewCount } from "@/modules/ai";

/**
 * GET /api/admin/candidates?reviewStatus=&jobId=
 *
 * The review queue. Only ever returns AI candidates — nothing here is in the
 * question bank yet (§2.2).
 */
export async function GET(request: Request) {
  try {
    await requireAdmin(request);
    const params = new URL(request.url).searchParams;

    const candidates = await listCandidates({
      jobId: params.get("jobId") ?? undefined,
      reviewStatus: params.get("reviewStatus") ?? "pending",
      limit: params.get("limit") ? Number(params.get("limit")) : 50,
    });

    return jsonResponse({ candidates, pending: await pendingReviewCount() });
  } catch (error) {
    return errorResponse(error);
  }
}
