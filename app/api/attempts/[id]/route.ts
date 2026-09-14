import { errorResponse, jsonResponse } from "@/lib/errors";
import { requireUser } from "@/modules/auth";
import { getAttemptQuestions, getAttemptState } from "@/modules/quiz";

/**
 * GET /api/attempts/:id — attempt state plus a window of questions.
 *
 * `?from=&count=` prefetches ahead so advancing feels instant. Every question
 * in the response is answer-stripped (§2.6).
 */

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext) {
  try {
    const user = await requireUser(request);
    const { id } = await context.params;
    const params = new URL(request.url).searchParams;

    const state = await getAttemptState(id, user.id);

    // Default to a small window around the resume point rather than the whole
    // paper: a 50-question set should never ship 50 questions in one payload.
    const from = params.get("from") ? Number(params.get("from")) : state.resumeIndex;
    const count = params.get("count") ? Number(params.get("count")) : 1;
    const questions = await getAttemptQuestions(id, user.id, from, Math.min(10, Math.max(1, count)));

    return jsonResponse({ attempt: state, questions });
  } catch (error) {
    return errorResponse(error);
  }
}
