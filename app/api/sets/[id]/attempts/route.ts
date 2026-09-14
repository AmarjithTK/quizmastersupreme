import { errorResponse, jsonResponse } from "@/lib/errors";
import { requireUser } from "@/modules/auth";
import { getAttemptQuestion, getAttemptState, startOrResumeAttempt } from "@/modules/quiz";

/**
 * POST /api/sets/:id/attempts — start a quiz, or resume the one in progress.
 *
 * Returns the attempt state plus the first question to show. The question has
 * NO correctness data on it (§2.6).
 *
 * There is deliberately no "start fresh" here: starting over is an explicit
 * separate action, so progress is never silently discarded (§11.4).
 */

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    const user = await requireUser(request);
    const { id } = await context.params;

    const { attempt, resumed } = await startOrResumeAttempt(user.id, id);
    const state = await getAttemptState(attempt.id, user.id);
    const question = await getAttemptQuestion(attempt.id, user.id, state.resumeIndex);

    return jsonResponse({ attempt: state, question, resumed });
  } catch (error) {
    return errorResponse(error);
  }
}
