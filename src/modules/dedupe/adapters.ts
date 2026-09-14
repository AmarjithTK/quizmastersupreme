/**
 * Binding-backed adapters for layer 3.
 *
 * Both Workers AI and Vectorize are OPTIONAL. If either binding is absent —
 * which is the default until the resources are provisioned — this returns null
 * and the funnel degrades gracefully instead of failing (§13.8). AI generation
 * must never be blocked by an indexing outage, and a question write must never
 * fail because a vector index is missing.
 */

import { bindings } from "@/lib/cloudflare/bindings";
import { workersAiEmbedder } from "./embeddings";
import type { SemanticDedupe } from "./layer3-semantic";
import { vectorizeIndex } from "./vector-index";

/**
 * The bindings are commented out in wrangler.jsonc until the Vectorize index
 * and Workers AI are provisioned, so `wrangler types` cannot see them. This is
 * the single narrow cast that acknowledges that.
 */
type OptionalAiBindings = {
  AI?: { run(model: string, input: unknown): Promise<unknown> };
  VECTORIZE?: Parameters<typeof vectorizeIndex>[0];
  EMBEDDING_MODEL?: string;
};

function optional(): OptionalAiBindings {
  return bindings() as unknown as OptionalAiBindings;
}

export function semanticDedupeAvailable(): boolean {
  const b = optional();
  return Boolean(b.AI && b.VECTORIZE);
}

export function resolveSemanticDedupe(): SemanticDedupe | null {
  const b = optional();
  if (!b.AI || !b.VECTORIZE) return null;

  return {
    embedder: workersAiEmbedder(b.AI, b.EMBEDDING_MODEL ?? "@cf/baai/bge-m3"),
    index: vectorizeIndex(b.VECTORIZE),
  };
}

/**
 * A semantic pair that cannot run is still useful for local development and for
 * tests: the feature-hash embedder plus an in-memory index exercises the whole
 * layer-3 path with no bindings at all.
 *
 * Used when `DEDUPE_LOCAL_SEMANTIC` is set, which is how the exit test for M12
 * runs end to end without a Vectorize account.
 */
export async function resolveLocalSemanticDedupe(): Promise<SemanticDedupe> {
  const { featureHashEmbedder } = await import("./embeddings");
  const { memoryVectorIndex } = await import("./vector-index");
  return { embedder: featureHashEmbedder(), index: memoryVectorIndex() };
}
