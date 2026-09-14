import { errorResponse, jsonResponse } from "@/lib/errors";
import { requireUser } from "@/modules/auth";
import { getAttemptQuestions } from "@/modules/quiz";

/**
 * GET /api/attempts/:id/questions?from=&count= — answer-stripped prefetch.
 *
 * The runner calls this ahead of the user so advancing is instant. Nothing in
 * the response reveals which option is correct (§2.6).
 */

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext) {
  try {
    const user = await requireUser(request);
    const { id } = await context.params;
    const params = new URL(request.url).searchParams;

    const from = Number(params.get("from") ?? 0);
    const count = Number(params.get("count") ?? 5);

    const questions = await getAttemptQuestions(
      id,
      user.id,
      Number.isFinite(from) ? Math.max(0, from) : 0,
      Number.isFinite(count) ? Math.min(10, Math.max(1, count)) : 5,
    );

    return jsonResponse({ questions });
  } catch (error) {
    return errorResponse(error);
  }
}

