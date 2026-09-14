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

import { inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { questions } from "@/db/schema";
import { computeDedupeHashes } from "@/modules/questions/normalize";
import { findExactDuplicate, type ExactMatch } from "./layer1-exact";

/** D1 caps bound parameters per statement at ~100; stay clearly under. */
const MAX_BOUND_PARAMS = 90;

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

/**
 * Batch version of `checkCandidate`.
 *
 * A generation job produces up to 50 candidates; running the layer-1 query once
 * per candidate would be 50 round trips. This resolves them with ONE query per
 * chunk by matching on the normalized hashes, then maps each verdict back.
 *
 * Layer 1 only, same as `checkCandidate` — layers 2 and 3 land in M11/M12 and
 * are reported as `degraded`.
 */
export async function checkCandidates(
  drafts: ReadonlyArray<{ stem: string; optionBodies: string[] }>,
): Promise<DedupeVerdict[]> {
  const hashes = await Promise.all(
    drafts.map((draft) => computeDedupeHashes(draft.stem, draft.optionBodies)),
  );

  const existing = new Map<string, { id: string; stem: string }>();
  const allHashes = hashes.map((h) => h.normalizedHash);

  for (let i = 0; i < allHashes.length; i += MAX_BOUND_PARAMS) {
    const chunk = allHashes.slice(i, i + MAX_BOUND_PARAMS);
    const rows = await db()
      .select({ id: questions.id, stem: questions.stem, normalizedHash: questions.normalizedHash })
      .from(questions)
      .where(inArray(questions.normalizedHash, chunk));
    for (const row of rows) existing.set(row.normalizedHash, { id: row.id, stem: row.stem });
  }

  return hashes.map((hash) => {
    const match = existing.get(hash.normalizedHash);
    if (match) {
      const best: DedupeMatch = {
        questionId: match.id,
        stem: match.stem,
        similarity: 1,
        layer: "exact",
      };
      return {
        status: "exact_dup",
        layer: "exact",
        normalizedHash: hash.normalizedHash,
        contentHash: hash.contentHash,
        bestMatch: best,
        allMatches: [best],
        autoReject: true,
        degraded: [],
      } satisfies DedupeVerdict;
    }

    return {
      status: "clean",
      layer: null,
      normalizedHash: hash.normalizedHash,
      contentHash: hash.contentHash,
      bestMatch: null,
      allMatches: [],
      autoReject: false,
      degraded: ["text", "semantic"],
    } satisfies DedupeVerdict;
  });
}
