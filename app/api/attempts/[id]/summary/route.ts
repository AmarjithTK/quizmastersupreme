import { errorResponse, jsonResponse } from "@/lib/errors";
import { requireUser } from "@/modules/auth";
import { getAttemptSummary } from "@/modules/quiz";

/**
 * GET /api/attempts/:id/summary — full review WITH correctness.
 *
 * Safe to expose because the attempt is finished; for an in-progress attempt
 * this would leak the whole answer key, so `getAttemptSummary` is only called
 * from the results page and the completion endpoint.
 */

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext) {
  try {
    const user = await requireUser(request);
    const { id } = await context.params;
    const summary = await getAttemptSummary(id, user.id);
    return jsonResponse({ summary });
  } catch (error) {
    return errorResponse(error);
  }
}
