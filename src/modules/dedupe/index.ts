/**
 * Dedupe engine — the funnel from PLAN.md §13.
 *
 *   candidate → ① exact hash → ② FTS5 + Jaccard → ③ embeddings → human
 *
 * Layer 1 auto-rejects: after normalization a match is provable identity.
 * Layer 2 only FLAGS (§13.6) — "Who created Linux?" and "In what year was Linux
 * released?" are both good questions, and a similarity score cannot tell that
 * apart from a genuine duplicate. Layer 3 lands in M12 and is reported as
 * `degraded` until then, so callers are never told a question is clean when it
 * has only been checked twice.
 */

import { inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { questions } from "@/db/schema";
import { computeDedupeHashes } from "@/modules/questions/normalize";
import { getDedupeThresholds, type DedupeThresholds } from "@/modules/settings";
import { findExactDuplicate, type ExactMatch } from "./layer1-exact";
import { classifyTextSimilarity, findTextDuplicates } from "./layer2-text";
import { findSemanticMatches, type SemanticDedupe } from "./layer3-semantic";

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
  /** Layers not yet run. Empty once M12 lands. */
  degraded: DedupeLayer[];
};

export type CandidateInput = {
  stem: string;
  optionBodies: string[];
  excludeQuestionId?: string;
};

export type CheckOptions = {
  /** Pass pre-read thresholds to avoid re-querying inside a batch. */
  thresholds?: DedupeThresholds;
  /**
   * Layer 3 dependencies. When absent, layer 3 is SKIPPED and reported as
   * degraded rather than treated as "clean" (§13.8) — callers at the edge
   * supply these when the bindings exist.
   */
  semantic?: SemanticDedupe | null;
};

/** Layer 1 + layer 2 for a single candidate. */
export async function checkCandidate(
  input: CandidateInput,
  options: CheckOptions = {},
): Promise<DedupeVerdict> {
  const [verdict] = await checkCandidates(
    [{ stem: input.stem, optionBodies: input.optionBodies }],
    { ...options, excludeQuestionId: input.excludeQuestionId },
  );
  return verdict!;
}

/**
 * Batch funnel.
 *
 * Layer 1 runs as ONE query per chunk of hashes. Layer 2 still issues one FTS
 * query per surviving candidate (each needs its own MATCH string), which is why
 * batch sizes are capped upstream.
 */
export async function checkCandidates(
  drafts: ReadonlyArray<{ stem: string; optionBodies: string[] }>,
  options: CheckOptions & { excludeQuestionId?: string } = {},
): Promise<DedupeVerdict[]> {
  if (drafts.length === 0) return [];

  const thresholds = options.thresholds ?? (await getDedupeThresholds());
  const hashes = await Promise.all(
    drafts.map((draft) => computeDedupeHashes(draft.stem, draft.optionBodies)),
  );

  // ── Layer 1: exact, in bulk ─────────────────────────────────────────────
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

  const verdicts: DedupeVerdict[] = [];

  for (const [index, hash] of hashes.entries()) {
    const exact = existing.get(hash.normalizedHash);

    if (exact && exact.id !== options.excludeQuestionId) {
      const match: DedupeMatch = {
        questionId: exact.id,
        stem: exact.stem,
        similarity: 1,
        layer: "exact",
      };
      verdicts.push({
        status: "exact_dup",
        layer: "exact",
        normalizedHash: hash.normalizedHash,
        contentHash: hash.contentHash,
        bestMatch: match,
        allMatches: [match],
        autoReject: true,
        degraded: [],
      });
      continue;
    }

    // ── Layer 2: FTS5 + Jaccard ───────────────────────────────────────────
    const text = await findTextDuplicates({
      stem: drafts[index]!.stem,
      excludeQuestionId: options.excludeQuestionId,
      limit: 5,
      threshold: thresholds.jaccardReview * 0.8,
    });

    const best = text.best;
    if (best) {
      const status = classifyTextSimilarity(best.similarity, {
        reject: thresholds.jaccardReject,
        review: thresholds.jaccardReview,
      });

      if (status !== "clean") {
        verdicts.push({
          status,
          layer: "text",
          normalizedHash: hash.normalizedHash,
          contentHash: hash.contentHash,
          // FLAGGED, never auto-rejected: similarity is not identity (§13.6).
          bestMatch: {
            questionId: best.questionId,
            stem: best.stem,
            similarity: best.similarity,
            layer: "text",
          },
          allMatches: text.matches.map((m) => ({
            questionId: m.questionId,
            stem: m.stem,
            similarity: m.similarity,
            layer: "text" as const,
          })),
          autoReject: false,
          degraded: ["semantic"],
        });
        continue;
      }
    }

    // ── Layer 3: embeddings + vector index ────────────────────────────────
    // A failure here must NOT fail the write: degrade and carry on (§13.8).
    if (options.semantic) {
      try {
        const semanticMatches = await findSemanticMatches({
          stem: drafts[index]!.stem,
          optionBodies: drafts[index]!.optionBodies,
          semantic: options.semantic,
          topK: 5,
          threshold: thresholds.semanticReview * 0.9,
          excludeQuestionId: options.excludeQuestionId,
        });

        const bestSemantic = semanticMatches[0];
        if (bestSemantic && bestSemantic.score >= thresholds.semanticReview) {
          verdicts.push({
            status: "semantic_dup",
            layer: "semantic",
            normalizedHash: hash.normalizedHash,
            contentHash: hash.contentHash,
            bestMatch: {
              questionId: bestSemantic.questionId,
              stem: "",
              similarity: bestSemantic.score,
              layer: "semantic",
            },
            allMatches: semanticMatches.map((m) => ({
              questionId: m.questionId,
              stem: "",
              similarity: m.score,
              layer: "semantic" as const,
            })),
            // Again: evidence, never a verdict (§13.6).
            autoReject: false,
            degraded: [],
          });
          continue;
        }

        verdicts.push({
          status: "clean",
          layer: null,
          normalizedHash: hash.normalizedHash,
          contentHash: hash.contentHash,
          bestMatch: null,
          allMatches: [],
          autoReject: false,
          degraded: [],
        });
        continue;
      } catch (error) {
        console.error("Layer 3 unavailable; degrading to layers 1-2", error);
      }
    }

    verdicts.push({
      status: "clean",
      layer: null,
      normalizedHash: hash.normalizedHash,
      contentHash: hash.contentHash,
      bestMatch: null,
      allMatches: [],
      autoReject: false,
      degraded: ["semantic"],
    });
  }

  return verdicts;
}

export { findExactDuplicate, type ExactMatch };
export { findTextDuplicates, jaccard, contentWords, classifyTextSimilarity } from "./layer2-text";
export { resolveSemanticDedupe, semanticDedupeAvailable } from "./adapters";
export { backfillEmbeddings, embeddingCoverage, type BackfillResult } from "./backfill";
export { embeddingText, cosineSimilarity, featureHashEmbedder, workersAiEmbedder, type Embedder } from "./embeddings";
export { memoryVectorIndex, vectorizeIndex, vectorIdFor, questionIdFromVectorId, type VectorIndex, type VectorMatch } from "./vector-index";
export { findSemanticMatches, type SemanticDedupe, type SemanticMatch } from "./layer3-semantic";
export {
  sweepExistingQuestions,
  listDuplicateFlags,
  resolveDuplicateFlag,
  openDuplicateCount,
  type SweepResult,
  type DuplicateFlagRow,
} from "./sweep";
