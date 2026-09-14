import { errorResponse, jsonResponse } from "@/lib/errors";
import { requireAdmin } from "@/modules/auth";
import { deleteQuestion, getQuestionForAdmin, updateQuestion } from "@/modules/questions";
import { parseQuestionPatch } from "../parse";

/**
 * /api/admin/questions/:id
 *
 * GET    — full question with its options (the editor payload).
 * PATCH  — update; re-validates and re-runs duplicate detection.
 * DELETE — PERMANENTLY delete the question (options, Q Set links and "seen"
 *          rows cascade; the FTS trigger cleans search).
 *
 * Archive is a separate action (`/status`), and DELETE refuses with a 409 when
 * a learner has already answered the question — deleting it would cascade away
 * their answer rows. The refusal names the real count.
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
    const { question, warnings } = await updateQuestion(id, parseQuestionPatch(body), actor.id);
    return jsonResponse({ question, warnings });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    const actor = await requireAdmin(request);
    const { id } = await context.params;
    const deleted = await deleteQuestion(id, actor.id);
    return jsonResponse({ deleted });
  } catch (error) {
    return errorResponse(error);
  }
}
