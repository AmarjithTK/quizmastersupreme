import { errorResponse, jsonResponse } from "@/lib/errors";
import { requireUser } from "@/modules/auth";
import { completeAttempt, getAttemptSummary } from "@/modules/quiz";

/**
 * POST /api/attempts/:id/complete
 *
 * Finalises the attempt and returns the summary. The score is computed from
 * stored answers server-side; nothing the client sends is trusted (§11.6).
 */

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    const user = await requireUser(request);
    const { id } = await context.params;

    await completeAttempt(id, user.id);
    const summary = await getAttemptSummary(id, user.id);

    return jsonResponse({ summary });
  } catch (error) {
    return errorResponse(error);
  }
}
