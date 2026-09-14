import { errorResponse, jsonResponse } from "@/lib/errors";
import { requireAdmin } from "@/modules/auth";
import { regenerateBatch } from "@/modules/ai";

/**
 * POST /api/admin/generation-jobs/:id/batches/:batchNo/regenerate
 *
 * Redo ONE internal batch (PIPELINE-PLAN.md §9). The batch's questions are
 * superseded — kept for audit, excluded from the review list, counts and commit
 * — and the job reopens so the next `/step` generates a fresh batch in its
 * place. A weak batch therefore costs one call, not the whole job.
 */

type RouteContext = { params: Promise<{ id: string; batchNo: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    const actor = await requireAdmin(request);
    const { id, batchNo } = await context.params;

    const parsed = Number(batchNo);
    if (!Number.isInteger(parsed) || parsed < 1) {
      return jsonResponse({ error: { code: "VALIDATION", message: "Invalid batch number." } }, {
        status: 422,
      });
    }

    const result = await regenerateBatch(id, parsed, actor.id);
    return jsonResponse(result);
  } catch (error) {
    return errorResponse(error);
  }
}
