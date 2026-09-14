import { errorResponse, jsonResponse } from "@/lib/errors";
import { requireUser } from "@/modules/auth";
import { submitAnswer } from "@/modules/quiz";
import type { OptionKey } from "@/db/schema";

/**
 * POST /api/attempts/:id/answers
 *
 * body: { questionId, selectedOptionKey, timeTakenMs?, clientSeq? }
 *
 * This is the ONLY endpoint that reveals correctness, the explanation and the
 * backstory — and only for a question the user has just answered (§2.6).
 *
 * Idempotent: re-submitting the same question updates the row rather than
 * creating a second one (§2.5), so a double-click or a retry is harmless.
 */

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    const user = await requireUser(request);
    const { id } = await context.params;
    const body = (await request.json()) as Record<string, unknown>;

    if (typeof body.questionId !== "string") {
      return jsonResponse(
        { error: { code: "VALIDATION", message: "questionId is required." } },
        { status: 422 },
      );
    }

    const selected =
      body.selectedOptionKey === null || body.selectedOptionKey === undefined
        ? null
        : (String(body.selectedOptionKey).trim().toUpperCase() as OptionKey);

    const result = await submitAnswer(id, user.id, {
      questionId: body.questionId,
      selectedOptionKey: selected,
      timeTakenMs: typeof body.timeTakenMs === "number" ? body.timeTakenMs : undefined,
      clientSeq: typeof body.clientSeq === "number" ? body.clientSeq : undefined,
    });

    return jsonResponse({ result });
  } catch (error) {
    return errorResponse(error);
  }
}
