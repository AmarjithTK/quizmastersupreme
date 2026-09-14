import { errorResponse, jsonResponse } from "@/lib/errors";
import { requireAdmin } from "@/modules/auth";
import { resolveDuplicateFlag } from "@/modules/dedupe";

/**
 * POST /api/admin/duplicates/:id/resolve — body: { action }
 *
 * action: 'confirmed' | 'dismissed' | 'merged'
 *
 * Resolving a flag is a DECISION about a pair, not a delete: both questions are
 * left alone. Removing one is a separate, explicit archive.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireAdmin(request);
    const { id } = await context.params;
    const body = (await request.json()) as { action?: unknown };

    if (!["confirmed", "dismissed", "merged"].includes(String(body.action))) {
      return jsonResponse(
        {
          error: {
            code: "VALIDATION",
            message: "action must be confirmed, dismissed or merged.",
          },
        },
        { status: 422 },
      );
    }

    await resolveDuplicateFlag(id, body.action as "confirmed" | "dismissed" | "merged", actor.id);
    return jsonResponse({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
