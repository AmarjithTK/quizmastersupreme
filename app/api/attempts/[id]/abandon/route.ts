import { errorResponse, jsonResponse } from "@/lib/errors";
import { requireUser } from "@/modules/auth";
import { abandonAttempt } from "@/modules/quiz";

/**
 * POST /api/attempts/:id/abandon — give up explicitly.
 *
 * Answers already given are KEPT (they are part of the user's history), but the
 * attempt does not count as a completion and its stats are not scored. This is
 * the only way to release the "one active attempt per set" slot other than
 * finishing.
 */

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    const user = await requireUser(request);
    const { id } = await context.params;
    const attempt = await abandonAttempt(id, user.id);
    return jsonResponse({ attempt });
  } catch (error) {
    return errorResponse(error);
  }
}
