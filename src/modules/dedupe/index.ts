/**
 * Dedupe engine — the two-layer funnel (REVAMP-PLAN.md §3.3 / §5.2).
 *
 *   candidate → ① exact hash → ② FTS5 + Jaccard → insert (or auto-filter)
 *
 * Layer 1 is provable identity after normalization. Layer 2 is a Jaccard score
 * against the bank, split into two bands by `app_settings` thresholds:
 *
 *   ≥ jaccardReject  → "near_dup"      → AUTO-FILTERED (same question, reworded)
 *   ≥ jaccardReview  → "possible_dup"  → shown as a badge, never blocks
 *   below both       → "clean"         → kept
 *
 * The layers 3 (embeddings/vector index), the retroactive sweep and the
 * duplicate_flags triage table were removed in the revamp: generation filters
 * duplicates as they arrive, and the bank is protected by the same funnel on
 * every write path (manual, CSV, AI).
 */

import { inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { questions } from "@/db/schema";
import { computeDedupeHashes } from "@/modules/questions/normalize";
import { getDedupeThresholds, type DedupeThresholds } from "@/modules/settings";
import { findExactDuplicate, type ExactMatch } from "./layer1-exact";
import { classifyTextSimilarity, findTextDuplicates } from "./layer2-text";

/** D1 caps bound parameters per statement at ~100; stay clearly under. */
const MAX_BOUND_PARAMS = 90;

export type DedupeStatus = "clean" | "exact_dup" | "near_dup" | "possible_dup";
export type DedupeLayer = "exact" | "text";

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
  /** True for exact matches AND near-duplicates: the caller must not store it. */
  autoReject: boolean;
};

export type CandidateInput = {
  stem: string;
  optionBodies: string[];
  excludeQuestionId?: string;
};

export type CheckOptions = {
  /** Pass pre-read thresholds to avoid re-querying inside a batch. */
  thresholds?: DedupeThresholds;
  excludeQuestionId?: string;
};

/** Should this candidate be dropped as a duplicate? The one rule callers need. */
export function isAutoFiltered(verdict: DedupeVerdict): boolean {
  return verdict.autoReject || verdict.status === "near_dup";
}

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
 * Layer 1 runs as ONE query per chunk of hashes. Layer 2 issues one FTS query
 * per surviving candidate (each needs its own MATCH string).
 */
export async function checkCandidates(
  drafts: ReadonlyArray<{ stem: string; optionBodies: string[] }>,
  options: CheckOptions = {},
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
          // Only the reject band is a hard filter; the review band is a badge.
          autoReject: status === "near_dup",
        });
        continue;
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
    });
  }

  return verdicts;
}

export { findExactDuplicate, type ExactMatch };
export { findTextDuplicates, jaccard, contentWords, classifyTextSimilarity } from "./layer2-text";
