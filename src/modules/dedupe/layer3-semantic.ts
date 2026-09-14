/**
 * Dedupe layer 3 — semantic similarity via embeddings + a vector index (M12).
 * PLAN.md §13.5.
 *
 * This is the layer that catches what wording-based comparison cannot:
 *
 *   "Who created Linux?"
 *   "Who was the original developer of the Linux kernel?"
 *   "Linux was initially developed by whom?"
 *
 * Layers 1 and 2 miss all three; layer 3 clusters them. Like layer 2, it FLAGS
 * and never auto-rejects (§13.6) — a high cosine score is evidence, not a
 * verdict, and two questions about the same subject can both be worth asking.
 */

import { embeddingText, type Embedder } from "./embeddings";
import { questionIdFromVectorId, vectorIdFor, type VectorIndex } from "./vector-index";

export type SemanticMatch = {
  questionId: string;
  score: number;
};

export type SemanticDedupe = {
  embedder: Embedder;
  index: VectorIndex;
};

/** Classify a cosine score against the configured bands. */
export function classifySemanticSimilarity(
  score: number,
  thresholds: { reject: number; review: number },
): "clean" | "semantic_dup" {
  if (score >= thresholds.reject) return "semantic_dup";
  if (score >= thresholds.review) return "semantic_dup";
  return "clean";
}

/**
 * Find semantically similar questions.
 *
 * Only PUBLISHED candidates are compared against, because a question that is
 * still a draft (or was rejected) must not block new content. That filter is
 * pushed into the index rather than applied afterwards: post-filtering a topK
 * list silently loses matches as the bank grows.
 */
export async function findSemanticMatches(input: {
  stem: string;
  optionBodies: readonly string[];
  semantic: SemanticDedupe;
  topK?: number;
  threshold?: number;
  excludeQuestionId?: string;
}): Promise<SemanticMatch[]> {
  const [vector] = await input.semantic.embedder.embed([
    embeddingText(input.stem, input.optionBodies),
  ]);

  if (!vector) return [];

  const matches = await input.semantic.index.query(vector, {
    topK: Math.min(20, Math.max(1, input.topK ?? 5)),
    filter: { status: "published" },
  });

  const threshold = input.threshold ?? 0;

  return matches
    .map((match) => ({
      questionId: questionIdFromVectorId(match.id),
      score: Math.round(match.score * 1000) / 1000,
    }))
    .filter((match) => match.questionId !== input.excludeQuestionId)
    .filter((match) => match.score >= threshold)
    .sort((a, b) => b.score - a.score);
}

export { vectorIdFor };
