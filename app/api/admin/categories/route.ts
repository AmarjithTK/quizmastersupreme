import { errorResponse, jsonResponse } from "@/lib/errors";
import { requireAdmin } from "@/modules/auth";
import { createCategory, listCategoriesForAdmin } from "@/modules/catalog";

/**
 * /api/admin/categories
 *
 * GET  — all categories (any status) for the management screen.
 * POST — create a category. Always starts as `draft`; an admin publishes it.
 */

export async function GET(request: Request) {
  try {
    const actor = await requireAdmin(request);
    const rows = await listCategoriesForAdmin();
    return jsonResponse({ categories: rows, actor: actor.id });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requireAdmin(request);
    const input = (await request.json()) as Record<string, unknown>;
    const category = await createCategory(
      {
        title: typeof input.title === "string" ? input.title : "",
        slug: typeof input.slug === "string" ? input.slug : undefined,
        subtitle: typeof input.subtitle === "string" ? input.subtitle : null,
        description: typeof input.description === "string" ? input.description : null,
        icon: typeof input.icon === "string" ? input.icon : null,
        accentColor: typeof input.accentColor === "string" ? input.accentColor : null,
        sortOrder: typeof input.sortOrder === "number" ? input.sortOrder : undefined,
      },
      actor.id,
    );
    return jsonResponse({ category }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}