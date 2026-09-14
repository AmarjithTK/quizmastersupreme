import { errorResponse, jsonResponse } from "@/lib/errors";
import { requireAdmin } from "@/modules/auth";
import { bulkReviewCandidates } from "@/modules/ai";

/**
 * POST /api/admin/candidates/bulk-review
 *
 * body: { ids: string[], action: 'approved'|'rejected'|'deferred' }
 *
 * Bulk review deliberately does NOT promote. Promotion runs each candidate
 * through the question funnel, and doing that for a hundred candidates in one
 * request would be both slow and a poor way to make a hundred content decisions.
 */
export async function POST(request: Request) {
  try {
    const actor = await requireAdmin(request);
    const body = (await request.json()) as { ids?: unknown; action?: unknown };

    if (!Array.isArray(body.ids) || body.ids.some((id) => typeof id !== "string")) {
      return jsonResponse(
        { error: { code: "VALIDATION", message: "ids must be an array of strings." } },
        { status: 422 },
      );
    }
    if (body.ids.length === 0) {
      return jsonResponse(
        { error: { code: "VALIDATION", message: "Select at least one candidate." } },
        { status: 422 },
      );
    }
    if (body.ids.length > 200) {
      return jsonResponse(
        { error: { code: "VALIDATION", message: "Review at most 200 candidates at a time." } },
        { status: 422 },
      );
    }
    if (!["approved", "rejected", "deferred"].includes(String(body.action))) {
      return jsonResponse(
        { error: { code: "VALIDATION", message: "action must be approved, rejected or deferred." } },
        { status: 422 },
      );
    }

    const result = await bulkReviewCandidates(
      body.ids as string[],
      body.action as "approved" | "rejected" | "deferred",
      actor.id,
    );
    return jsonResponse(result);
  } catch (error) {
    return errorResponse(error);
  }
}
