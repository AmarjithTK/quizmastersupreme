import { errorResponse, jsonResponse } from "@/lib/errors";
import { requireAdmin } from "@/modules/auth";
import { reorderSetQuestions } from "@/modules/questions";

/**
 * POST /api/admin/sets/:id/questions/reorder — body: { questionIds: string[] }
 *
 * The array IS the new order: index 0 plays first.
 */

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    const actor = await requireAdmin(request);
    const { id } = await context.params;
    const body = (await request.json()) as { questionIds?: unknown };

    if (
      !Array.isArray(body.questionIds) ||
      body.questionIds.some((q) => typeof q !== "string")
    ) {
      return jsonResponse(
        { error: { code: "VALIDATION", message: "questionIds must be an array of strings." } },
        { status: 422 },
      );
    }

    await reorderSetQuestions(id, body.questionIds as string[], actor.id);
    return jsonResponse({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
