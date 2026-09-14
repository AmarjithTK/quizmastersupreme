import { errorResponse, jsonResponse } from "@/lib/errors";
import { requireAdmin } from "@/modules/auth";
import { setQuestionStatus } from "@/modules/questions";
import type { QuestionStatus } from "@/db/schema";

/**
 * POST /api/admin/questions/:id/status — body: { status }
 *
 * Approving or publishing stamps `approvedBy`/`approvedAt`. That attribution is
 * the mechanism behind PLAN.md §2.2: a named human vouched for this content.
 */

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    const actor = await requireAdmin(request);
    const { id } = await context.params;
    const body = (await request.json()) as { status?: unknown };

    if (typeof body.status !== "string") {
      return jsonResponse(
        { error: { code: "VALIDATION", message: "A status string is required." } },
        { status: 422 },
      );
    }

    const question = await setQuestionStatus(id, body.status as QuestionStatus, actor.id);
    return jsonResponse({ question });
  } catch (error) {
    return errorResponse(error);
  }
}
