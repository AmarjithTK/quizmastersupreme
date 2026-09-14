import { errorResponse, jsonResponse } from "@/lib/errors";
import { requireAdmin } from "@/modules/auth";
import { archiveQuestion, getQuestionForAdmin, updateQuestion } from "@/modules/questions";
import { resolveSemanticDedupe } from "@/modules/dedupe";
import { parseQuestionPatch } from "../parse";

/**
 * /api/admin/questions/:id
 *
 * GET    — full question with its options (the editor payload).
 * PATCH  — update; re-validates and re-runs duplicate detection.
 * DELETE — archive, never a hard delete: answers reference question_id.
 */

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext) {
  try {
    await requireAdmin(request);
    const { id } = await context.params;
    const question = await getQuestionForAdmin(id);
    return jsonResponse({ question });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const actor = await requireAdmin(request);
    const { id } = await context.params;
    const body = (await request.json()) as Record<string, unknown>;
    const { question, warnings } = await updateQuestion(id, parseQuestionPatch(body), actor.id, {
      semantic: resolveSemanticDedupe(),
    });
    return jsonResponse({ question, warnings });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    const actor = await requireAdmin(request);
    const { id } = await context.params;
    const question = await archiveQuestion(id, actor.id);
    return jsonResponse({ question });
  } catch (error) {
    return errorResponse(error);
  }
}
