import { errorResponse, jsonResponse } from "@/lib/errors";
import { requireAdmin } from "@/modules/auth";
import { createSet, listSetsForAdmin } from "@/modules/catalog";
import { parseSetCreate } from "./parse";

/**
 * /api/admin/sets
 *
 * GET  — all quiz sets (any status), optionally `?categoryId=` filtered.
 * POST — create a set inside a category. Always starts as `draft`.
 */

export async function GET(request: Request) {
  try {
    await requireAdmin(request);
    const categoryId = new URL(request.url).searchParams.get("categoryId") ?? undefined;
    const sets = await listSetsForAdmin(categoryId);
    return jsonResponse({ sets });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requireAdmin(request);
    const body = (await request.json()) as Record<string, unknown>;
    const set = await createSet(parseSetCreate(body), actor.id);
    return jsonResponse({ set }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}