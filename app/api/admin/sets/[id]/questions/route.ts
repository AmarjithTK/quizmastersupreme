import { errorResponse, jsonResponse } from "@/lib/errors";
import { requireAdmin } from "@/modules/auth";
import { attachQuestions, detachQuestions, listSetQuestions } from "@/modules/questions";

/**
 * /api/admin/sets/:id/questions — membership of one quiz set.
 *
 * GET  — the set's questions in play order.
 * POST — attach questions (appended). Idempotent: already-attached ids are
 *        reported as `skipped`, never moved.
 */

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext) {
  try {
    await requireAdmin(request);
    const { id } = await context.params;
    const questions = await listSetQuestions(id);
    return jsonResponse({ questions });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const actor = await requireAdmin(request);
    const { id } = await context.params;
    const body = (await request.json()) as { questionIds?: unknown };

    if (
      !Array.isArray(body.questionIds) ||
      body.questionIds.some((q) => typeof q !== "string")
    ) {
      return jsonResponse(
        { error: { code: "VALIDATION", message: "questionIds must be an array of strings." } },
        { status: 422 },
      );
    }

    const result = await attachQuestions(id, body.questionIds as string[], actor.id);
    return jsonResponse(result);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    const actor = await requireAdmin(request);
    const { id } = await context.params;
    const body = (await request.json()) as { questionIds?: unknown };

    if (!Array.isArray(body.questionIds)) {
      return jsonResponse(
        { error: { code: "VALIDATION", message: "questionIds must be an array of strings." } },
        { status: 422 },
      );
    }

    const removed = await detachQuestions(id, body.questionIds as string[], actor.id);
    return jsonResponse({ removed });
  } catch (error) {
    return errorResponse(error);
  }
}
