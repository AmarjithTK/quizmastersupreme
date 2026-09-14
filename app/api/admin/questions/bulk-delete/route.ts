import { errorResponse, jsonResponse } from "@/lib/errors";
import { requireAdmin } from "@/modules/auth";
import { bulkDeleteQuestions } from "@/modules/questions";

/**
 * POST /api/admin/questions/bulk-delete
 *
 * Permanently delete many questions at once. Questions a learner has already
 * answered are SKIPPED (and reported by id, with the reason) rather than failing
 * the whole action — see `deleteQuestion` for why that guard exists.
 */

export async function POST(request: Request) {
  try {
    const actor = await requireAdmin(request);
    const body = (await request.json()) as { ids?: unknown };

    const ids = Array.isArray(body.ids)
      ? body.ids.filter((value): value is string => typeof value === "string")
      : [];
    if (ids.length === 0) {
      return jsonResponse({ deleted: 0, deletedIds: [], blocked: [] });
    }

    const result = await bulkDeleteQuestions(ids, actor.id);
    return jsonResponse(result);
  } catch (error) {
    return errorResponse(error);
  }
}
