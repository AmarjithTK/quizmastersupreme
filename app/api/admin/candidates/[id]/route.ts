import { errorResponse, jsonResponse } from "@/lib/errors";
import { requireAdmin } from "@/modules/auth";
import { setCandidateRejected } from "@/modules/ai";

/**
 * PATCH /api/admin/candidates/:id — body: { rejected: boolean }
 *
 * The reviewer's single decision on a generated question. Rejected rows are
 * skipped when the batch is committed; nothing is deleted, so the decision can
 * be undone until the batch is added to a Q Set.
 */

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const actor = await requireAdmin(request);
    const { id } = await context.params;
    const body = (await request.json()) as { rejected?: unknown };

    if (typeof body.rejected !== "boolean") {
      return jsonResponse(
        { error: { code: "VALIDATION", message: "`rejected` must be true or false." } },
        { status: 422 },
      );
    }

    const candidate = await setCandidateRejected(id, body.rejected, actor.id);
    return jsonResponse({ candidate });
  } catch (error) {
    return errorResponse(error);
  }
}
