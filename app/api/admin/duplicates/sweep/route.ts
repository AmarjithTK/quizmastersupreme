import { errorResponse, jsonResponse } from "@/lib/errors";
import { requireAdmin } from "@/modules/auth";
import { sweepExistingQuestions } from "@/modules/dedupe";

/**
 * POST /api/admin/duplicates/sweep — body: { limit? }
 *
 * Re-scans part of the existing bank for near-duplicates. Bounded on purpose:
 * it is N FTS queries, so it is deliberately an admin action rather than an
 * unbounded background job.
 */
export async function POST(request: Request) {
  try {
    const actor = await requireAdmin(request);
    const body = (await request.json().catch(() => ({}))) as { limit?: unknown };

    const result = await sweepExistingQuestions({
      limit: typeof body.limit === "number" ? body.limit : 100,
      actorId: actor.id,
    });

    return jsonResponse({ result });
  } catch (error) {
    return errorResponse(error);
  }
}
