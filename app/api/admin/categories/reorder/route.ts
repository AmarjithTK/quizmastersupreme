import { errorResponse, jsonResponse } from "@/lib/errors";
import { requireAdmin } from "@/modules/auth";
import { reorderCategories } from "@/modules/catalog";

/** POST /api/admin/categories/reorder — body: { orderedIds: string[] } */
export async function POST(request: Request) {
  try {
    const actor = await requireAdmin(request);
    const body = (await request.json()) as { orderedIds?: unknown };
    if (!Array.isArray(body.orderedIds) || body.orderedIds.some((id) => typeof id !== "string")) {
      return jsonResponse(
        { error: { code: "VALIDATION", message: "orderedIds must be an array of strings" } },
        { status: 422 },
      );
    }
    await reorderCategories(body.orderedIds as string[], actor.id);
    return jsonResponse({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}