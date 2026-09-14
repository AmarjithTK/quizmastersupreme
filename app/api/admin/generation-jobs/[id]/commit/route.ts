import { errorResponse, jsonResponse } from "@/lib/errors";
import { requireAdmin } from "@/modules/auth";
import { commitJobToSet } from "@/modules/ai";

/**
 * POST /api/admin/generation-jobs/:id/commit
 *
 * The batch flow's single commit action: promote every non-rejected candidate
 * of the job into the question bank, then add the WHOLE approved set to a
 * Q Set — an existing one ({ targetSetId }) or a brand-new one ({ newSet }).
 *
 * Exactly one of targetSetId / newSet must be given.
 */

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    const actor = await requireAdmin(request);
    const { id } = await context.params;
    const body = (await request.json()) as Record<string, unknown>;

    const newSetBody =
      body.newSet && typeof body.newSet === "object"
        ? (body.newSet as Record<string, unknown>)
        : null;

    const outcome = await commitJobToSet(id, actor.id, {
      setId: typeof body.targetSetId === "string" && body.targetSetId ? body.targetSetId : null,
      newSet: newSetBody
        ? {
            title: typeof newSetBody.title === "string" ? newSetBody.title : "",
            categoryId: typeof newSetBody.categoryId === "string" ? newSetBody.categoryId : "",
            mode: typeof newSetBody.mode === "string" ? newSetBody.mode : undefined,
            difficulty: typeof newSetBody.difficulty === "string" ? newSetBody.difficulty : undefined,
            description:
              typeof newSetBody.description === "string" ? newSetBody.description : null,
          }
        : null,
    });

    return jsonResponse({ outcome });
  } catch (error) {
    return errorResponse(error);
  }
}