import { errorResponse, jsonResponse } from "@/lib/errors";
import { requireAdmin } from "@/modules/auth";
import { promoteCandidate } from "@/modules/ai";
import type { QuestionStatus } from "@/db/schema";

/**
 * POST /api/admin/candidates/:id/promote
 *
 * The ONLY route that turns an AI candidate into a real question. It calls
 * `promoteCandidate` → `createQuestion`, so the promoted question passes the
 * same validation and duplicate funnel as anything typed by hand (§2.2, §2.9).
 *
 * A candidate that duplicates something already in the bank is rejected HERE
 * with a 409, which is the last line of defence behind the candidate-time
 * dedupe check.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireAdmin(request);
    const { id } = await context.params;
    const body = (await request.json().catch(() => ({}))) as { status?: unknown };

    const { candidate, questionId } = await promoteCandidate(id, actor.id, {
      // Approved but NOT published: publishing stays a separate, deliberate act.
      status: (typeof body.status === "string" ? body.status : "approved") as QuestionStatus,
    });

    return jsonResponse({ candidate, questionId });
  } catch (error) {
    return errorResponse(error);
  }
}
