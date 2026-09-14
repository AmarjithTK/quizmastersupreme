import { errorResponse, jsonResponse } from "@/lib/errors";
import { requireAdmin } from "@/modules/auth";
import { archiveCategory, updateCategory } from "@/modules/catalog";

/**
 * /api/admin/categories/:id
 *
 * PATCH  — update fields. Body may contain any subset of public fields.
 * DELETE — archive (NOT drop — quiz_sets holds a RESTRICT FK).
 */

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const actor = await requireAdmin(request);
    const { id } = await context.params;
    const body = (await request.json()) as Record<string, unknown>;

    const category = await updateCategory(
      id,
      {
        title: typeof body.title === "string" ? body.title : undefined,
        slug: typeof body.slug === "string" ? body.slug : undefined,
        subtitle: typeof body.subtitle === "string" ? body.subtitle : undefined,
        description: typeof body.description === "string" ? body.description : undefined,
        icon: typeof body.icon === "string" ? body.icon : undefined,
        accentColor: typeof body.accentColor === "string" ? body.accentColor : undefined,
        sortOrder: typeof body.sortOrder === "number" ? body.sortOrder : undefined,
        status: typeof body.status === "string" ? (body.status as "draft" | "published" | "archived") : undefined,
      },
      actor.id,
    );
    return jsonResponse({ category });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    const actor = await requireAdmin(request);
    const { id } = await context.params;
    const category = await archiveCategory(id, actor.id);
    return jsonResponse({ category });
  } catch (error) {
    return errorResponse(error);
  }
}