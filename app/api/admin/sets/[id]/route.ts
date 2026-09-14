import { errorResponse, jsonResponse } from "@/lib/errors";
import { requireAdmin } from "@/modules/auth";
import { archiveSet, updateSet } from "@/modules/catalog";
import { parseSetPatch } from "../parse";

/**
 * /api/admin/sets/:id
 *
 * PATCH  — update fields. `categoryId` is not patchable (see admin-sets.ts).
 * DELETE — archive; never a hard delete, because question_set_questions
 *          cascades and would silently detach historical attempts.
 */

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const actor = await requireAdmin(request);
    const { id } = await context.params;
    const body = (await request.json()) as Record<string, unknown>;
    const set = await updateSet(id, parseSetPatch(body), actor.id);
    return jsonResponse({ set });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    const actor = await requireAdmin(request);
    const { id } = await context.params;
    const set = await archiveSet(id, actor.id);
    return jsonResponse({ set });
  } catch (error) {
    return errorResponse(error);
  }
}