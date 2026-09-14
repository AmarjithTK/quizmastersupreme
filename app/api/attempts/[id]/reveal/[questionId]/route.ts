import { errorResponse, jsonResponse } from "@/lib/errors";
import { requireUser } from "@/modules/auth";
import { getAnswerReveal } from "@/modules/quiz";

/**
 * GET /api/attempts/:id/reveal/:questionId
 *
 * Re-shows the explanation and backstory for a question the user has ALREADY
 * answered — for navigating back, or after resuming.
 *
 * Returns 409 for anything unanswered. That check is the whole point: without
 * it this would be an answer-key endpoint (§2.6).
 */

type RouteContext = { params: Promise<{ id: string; questionId: string }> };

export async function GET(request: Request, context: RouteContext) {
  try {
    const user = await requireUser(request);
    const { id, questionId } = await context.params;
    const result = await getAnswerReveal(id, user.id, questionId);
    return jsonResponse({ result });
  } catch (error) {
    return errorResponse(error);
  }
}
