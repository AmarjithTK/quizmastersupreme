/**
 * Dedupe engine — the funnel from PLAN.md §13.
 *
 *   candidate → ① exact hash → ② FTS5 + Jaccard → ③ embeddings → human
 *
 * Layers 2 and 3 are NOT implemented yet (M11 and M12). `checkCandidate`
 * therefore reports `clean` when layer 1 misses, and `degraded` is set so
 * callers and the UI can be honest that a question has not yet been checked
 * for near- or semantic duplicates.
 *
 * The verdict shape is final, so wiring the later layers in will not change
 * any caller.
 */

import { computeDedupeHashes } from "@/modules/questions/normalize";
import { findExactDuplicate, type ExactMatch } from "./layer1-exact";

export type DedupeStatus = "clean" | "exact_dup" | "near_dup" | "semantic_dup";
export type DedupeLayer = "exact" | "text" | "semantic";

export type DedupeMatch = {
  questionId: string;
  stem: string;
  similarity: number;
  layer: DedupeLayer;
};

export type DedupeVerdict = {
  status: DedupeStatus;
  layer: DedupeLayer | null;
  normalizedHash: string;
  contentHash: string;
  bestMatch: DedupeMatch | null;
  allMatches: DedupeMatch[];
  /** True ONLY for layer-1 exact matches. Never true for fuzzy matches. */
  autoReject: boolean;
  /** Layers not yet run. Empty once M11/M12 land. */
  degraded: DedupeLayer[];
};

export async function checkCandidate(input: {
  stem: string;
  optionBodies: string[];
  excludeQuestionId?: string;
}): Promise<DedupeVerdict> {
  const { normalizedHash, contentHash } = await computeDedupeHashes(input.stem, input.optionBodies);

  const exact: ExactMatch | null = await findExactDuplicate({
    normalizedHash,
    contentHash,
    excludeQuestionId: input.excludeQuestionId,
  });

  if (exact) {
    const match: DedupeMatch = {
      questionId: exact.questionId,
      stem: exact.stem,
      // Exact matches are identity, so similarity is 1 by definition.
      similarity: 1,
      layer: "exact",
    };
    return {
      status: "exact_dup",
      layer: "exact",
      normalizedHash,
      contentHash,
      bestMatch: match,
      allMatches: [match],
      autoReject: true,
      degraded: [],
    };
  }

  return {
    status: "clean",
    layer: null,
    normalizedHash,
    contentHash,
    bestMatch: null,
    allMatches: [],
    autoReject: false,
    // Honest about what has NOT been checked yet.
    degraded: ["text", "semantic"],
  };
}

export { findExactDuplicate, type ExactMatch };
