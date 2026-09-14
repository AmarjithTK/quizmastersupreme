import { errorResponse, jsonResponse } from "@/lib/errors";
import { requireAdmin } from "@/modules/auth";
import { createQuestion, listQuestionsForAdmin } from "@/modules/questions";
import { parseQuestionCreate } from "./parse";

/**
 * /api/admin/questions
 *
 * GET  — paginated bank with FTS5 search and filters.
 * POST — create a question through the shared funnel (validate → dedupe → insert).
 */

export async function GET(request: Request) {
  try {
    await requireAdmin(request);
    const params = new URL(request.url).searchParams;

    const result = await listQuestionsForAdmin({
      q: params.get("q") ?? undefined,
      status: params.get("status") ?? undefined,
      difficulty: params.get("difficulty") ?? undefined,
      topic: params.get("topic") ?? undefined,
      origin: params.get("origin") ?? undefined,
      setId: params.get("setId") ?? undefined,
      page: params.get("page") ? Number(params.get("page")) : undefined,
      pageSize: params.get("pageSize") ? Number(params.get("pageSize")) : undefined,
    });

    return jsonResponse(result);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requireAdmin(request);
    const body = (await request.json()) as Record<string, unknown>;
    const status = typeof body.status === "string" ? body.status : "draft";

    const { question, warnings } = await createQuestion(
      parseQuestionCreate(body),
      actor.id,
      { status: status as never },
    );

    return jsonResponse({ question, warnings }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
