import { errorResponse, jsonResponse } from "@/lib/errors";
import { requireAdmin } from "@/modules/auth";
import { bulkSetQuestionStatus } from "@/modules/questions";
import type { QuestionStatus } from "@/db/schema";

/** POST /api/admin/questions/bulk-status — body: { ids: string[], status } */
export async function POST(request: Request) {
  try {
    const actor = await requireAdmin(request);
    const body = (await request.json()) as { ids?: unknown; status?: unknown };

    if (!Array.isArray(body.ids) || body.ids.some((id) => typeof id !== "string")) {
      return jsonResponse(
        { error: { code: "VALIDATION", message: "ids must be an array of strings." } },
        { status: 422 },
      );
    }
    if (typeof body.status !== "string") {
      return jsonResponse(
        { error: { code: "VALIDATION", message: "A status string is required." } },
        { status: 422 },
      );
    }
    if (body.ids.length === 0) {
      return jsonResponse(
        { error: { code: "VALIDATION", message: "Select at least one question." } },
        { status: 422 },
      );
    }
    if (body.ids.length > 500) {
      return jsonResponse(
        { error: { code: "VALIDATION", message: "Change at most 500 questions at a time." } },
        { status: 422 },
      );
    }

    const result = await bulkSetQuestionStatus(body.ids as string[], body.status as QuestionStatus, actor.id);
    return jsonResponse(result);
  } catch (error) {
    return errorResponse(error);
  }
}
