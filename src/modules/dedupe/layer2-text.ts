/**
 * Dedupe layer 2 — FTS5 candidate retrieval + Jaccard token overlap.
 * PLAN.md §13.4.
 *
 * Cheapest-first: BM25 narrows the bank to ~20 plausible candidates, then a
 * token-overlap score decides how similar they really are. This catches the
 * paraphrases layer 1 misses without paying for an embedding call.
 *
 * THRESHOLDS are read from `app_settings` (see modules/settings) rather than
 * hard-coded, so they can be tuned against real data without a deploy. The
 * defaults here are the starting point, not the answer.
 */

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { questions } from "@/db/schema";
import { normalizeStem } from "@/modules/questions";

/** Very common words carry no signal for overlap scoring. */
const STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "of", "in", "on", "at", "to", "for", "with", "by", "from", "as",
  "and", "or", "but", "if", "then", "than", "that", "this", "these", "those",
  "it", "its", "which", "who", "whom", "whose", "what", "when", "where", "why", "how",
  "do", "does", "did", "can", "could", "will", "would", "should", "may", "might",
  "not", "no", "yes", "all", "any", "both", "each", "few", "more", "most", "other",
  "some", "such", "only", "own", "same", "so", "too", "very", "into", "during",
  "following", "used", "use", "using", "known", "called", "developed", "create",
  "created", "first", "also", "one", "two", "three",
]);

export function contentWords(text: string): string[] {
  return normalizeStem(text)
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOPWORDS.has(word));
}

export function jaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const word of setA) if (setB.has(word)) intersection += 1;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Build an FTS5 MATCH from a question stem.
 *
 * Only the most distinctive terms are used — the longest ones, on the theory
 * that length correlates with specificity in exam prose ("mitochondrion" beats
 * "cell"). Every term is quoted so user text can never be parsed as FTS syntax,
 * and passing them as ONE parameter keeps D1's ~100 bound-parameter ceiling at
 * arm's length.
 */
export function buildDistinctiveMatch(stem: string, maxTerms = 8): string {
  const terms = contentWords(stem)
    .sort((a, b) => b.length - a.length)
    .slice(0, maxTerms)
    .map((term) => `"${term}"`);
  return terms.join(" OR ");
}

export type TextMatch = {
  questionId: string;
  stem: string;
  /** Jaccard overlap of content words. */
  similarity: number;
  status: string;
};

export type TextDuplicateResult = {
  matches: TextMatch[];
  best: TextMatch | null;
};

/**
 * Find textually similar questions already in the bank.
 *
 * `threshold` filters the returned list; callers decide what to DO about a
 * match based on their own review/reject thresholds — this function never
 * deletes or rejects anything.
 */
export async function findTextDuplicates(input: {
  stem: string;
  excludeQuestionId?: string;
  limit?: number;
  threshold?: number;
}): Promise<TextDuplicateResult> {
  const match = buildDistinctiveMatch(input.stem);
  if (!match) return { matches: [], best: null };

  const limit = Math.min(50, Math.max(1, input.limit ?? 20));
  const threshold = input.threshold ?? 0;

  // Subquery rather than an id list: one bound parameter regardless of how many
  // rows the MATCH returns.
  //
  // Conditions are pushed conditionally: an empty `sql` fragment inside and()
  // renders as nothing and produces a dangling `and )`, which is a syntax error.
  const conditions = [
    sql`${questions.id} in (
      select question_id from questions_fts
      where questions_fts match ${match}
      order by rank
      limit ${limit * 4}
    )`,
    sql`${questions.status} not in ('archived','rejected')`,
  ];
  if (input.excludeQuestionId) {
    conditions.push(sql`${questions.id} <> ${input.excludeQuestionId}`);
  }

  const rows = await db()
    .select({ id: questions.id, stem: questions.stem, status: questions.status })
    .from(questions)
    .where(and(...conditions))
    .limit(limit * 4);

  const candidateWords = contentWords(input.stem);

  const matches: TextMatch[] = rows
    .map((row) => ({
      questionId: row.id,
      stem: row.stem,
      status: row.status,
      similarity: Math.round(jaccard(candidateWords, contentWords(row.stem)) * 1000) / 1000,
    }))
    .filter((m) => m.similarity >= threshold)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);

  return { matches, best: matches[0] ?? null };
}

/** Classify a Jaccard score against the configured bands. */
export function classifyTextSimilarity(
  similarity: number,
  thresholds: { reject: number; review: number },
): "clean" | "near_dup" | "semantic_dup" {
  if (similarity >= thresholds.reject) return "near_dup";
  if (similarity >= thresholds.review) return "semantic_dup";
  return "clean";
}
