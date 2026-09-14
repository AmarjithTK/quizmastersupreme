import { errorResponse, jsonResponse } from "@/lib/errors";
import { isDev } from "@/lib/cloudflare/bindings";
import { requireAdmin } from "@/modules/auth";
import { backfillEmbeddings, embeddingCoverage, resolveSemanticDedupe } from "@/modules/dedupe";
import { recordAudit } from "@/modules/audit";

/**
 * /api/admin/embeddings
 *
 * GET  — how much of the bank is embedded, and whether layer 3 can run at all.
 * POST — run a backfill. This is the repair path that makes the vector index
 *        disposable (§2.3): drop the index, POST here, and layer 3 works again.
 *
 * The embedder is auto-selected:
 *   - Workers AI when the AI + Vectorize bindings exist (production), or
 *   - a deterministic local embedder in development, clearly flagged, so the
 *     whole path is exercisable without provisioning anything.
 *
 * In production with no bindings this REFUSES rather than silently indexing
 * with a stand-in model — writing feature-hash vectors into a real Vectorize
 * index would quietly degrade every later similarity comparison.
 */

export async function GET(request: Request) {
  try {
    await requireAdmin(request);
    const coverage = await embeddingCoverage();
    const configured = resolveSemanticDedupe() !== null;
    return jsonResponse({
      ...coverage,
      configured,
      localFallback: !configured && isDev(),
      model: resolveSemanticDedupe()?.embedder.model ?? null,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requireAdmin(request);
    const body = (await request.json().catch(() => ({}))) as { limit?: unknown; force?: unknown };

    let semantic = resolveSemanticDedupe();
    const usingFallback = semantic === null && isDev();

    if (!semantic) {
      if (!isDev()) {
        return jsonResponse(
          {
            error: {
              code: "VALIDATION",
              message:
                "Embeddings are not configured. Provision the Workers AI and Vectorize bindings (see wrangler.jsonc) before backfilling.",
            },
          },
          { status: 422 },
        );
      }
      const { resolveLocalSemanticDedupe } = await import("@/modules/dedupe/adapters");
      semantic = await resolveLocalSemanticDedupe();
    }

    const result = await backfillEmbeddings(
      { embedder: semantic.embedder, index: semantic.index },
      {
        limit: typeof body.limit === "number" ? body.limit : 100,
        force: body.force === true,
        actorId: actor.id,
        // Do not record embeddings that live only in memory.
        persist: !usingFallback,
      },
    );

    if (usingFallback) {
      await recordAudit(actor.id, "dedupe.backfill_local_fallback", "question", null, null, {
        model: semantic.embedder.model,
        note: "Development only: vectors were produced by the local stand-in embedder.",
      });
    }

    return jsonResponse({
      result,
      usingFallback,
      model: semantic.embedder.model,
      // Be explicit rather than implying dev has working semantic search: with
      // no Vectorize binding the index is in-memory and does not survive the
      // request, so this proves the PATH, not the capability.
      note: usingFallback
        ? "Development fallback: the index is in-memory and does not persist, so no embedding rows were recorded. Provision the Vectorize binding for real semantic search."
        : undefined,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

