/**
 * Dedupe layer 1 — exact matching on normalized hashes.
 * PLAN.md §13.2.
 *
 * This is the only layer that may AUTO-REJECT: after normalization, a match is
 * provable identity, not a judgement call. Everything fuzzier (layers 2 and 3)
 * flags for a human instead — see §13.6.
 *
 * Layers 2 (FTS5 + Jaccard) and 3 (embeddings) land in M11 and M12.
 */

import { and, eq, ne, or } from "drizzle-orm";
import { db } from "@/db/client";
import { questions } from "@/db/schema";

export type ExactMatch = {
  questionId: string;
  stem: string;
  status: string;
  /** Which hash collided. `content_hash` implies identical options too. */
  matchType: "normalized_hash" | "content_hash";
};

export async function findExactDuplicate(input: {
  normalizedHash: string;
  contentHash: string;
  excludeQuestionId?: string;
}): Promise<ExactMatch | null> {
  const conditions = [
    or(
      eq(questions.normalizedHash, input.normalizedHash),
      eq(questions.contentHash, input.contentHash),
    ),
  ];
  if (input.excludeQuestionId) {
    conditions.push(ne(questions.id, input.excludeQuestionId));
  }

  const row = (
    await db()
      .select({
        id: questions.id,
        stem: questions.stem,
        status: questions.status,
        normalizedHash: questions.normalizedHash,
        contentHash: questions.contentHash,
      })
      .from(questions)
      .where(and(...conditions))
      .limit(1)
  )[0];

  if (!row) return null;

  return {
    questionId: row.id,
    stem: row.stem,
    status: row.status,
    matchType: row.normalizedHash === input.normalizedHash ? "normalized_hash" : "content_hash",
  };
}
