import { errorResponse, jsonResponse } from "@/lib/errors";
import { requireAdmin } from "@/modules/auth";
import { getCandidate, promoteCandidate, reviewCandidate } from "@/modules/ai";
import type { QuestionStatus } from "@/db/schema";

/**
 * POST /api/admin/candidates/:id/review
 *
 * body: { action: 'approved'|'rejected'|'merged'|'deferred', note?, promote? }
 *
 * `promote: true` also pushes an approved candidate into the question bank,
 * through `promoteCandidate` → `createQuestion`, so the funnel still applies.
 */

type RouteContext = { params: Promise<{ id: string }> };

const ACTIONS = ["approved", "rejected", "merged", "deferred"] as const;

export async function POST(request: Request, context: RouteContext) {
  try {
    const actor = await requireAdmin(request);
    const { id } = await context.params;
    const body = (await request.json()) as Record<string, unknown>;

    const action = body.action;
    if (typeof action !== "string" || !(ACTIONS as readonly string[]).includes(action)) {
      return jsonResponse(
        { error: { code: "VALIDATION", message: `action must be one of: ${ACTIONS.join(", ")}.` } },
        { status: 422 },
      );
    }

    await reviewCandidate(
      id,
      action as (typeof ACTIONS)[number],
      actor.id,
      typeof body.note === "string" ? body.note : null,
    );

    if (body.promote === true) {
      const { questionId } = await promoteCandidate(id, actor.id, {
        status: (typeof body.status === "string" ? body.status : "approved") as QuestionStatus,
      });
      return jsonResponse({ candidate: await getCandidate(id), questionId });
    }

    return jsonResponse({ candidate: await getCandidate(id) });
  } catch (error) {
    return errorResponse(error);
  }
}
