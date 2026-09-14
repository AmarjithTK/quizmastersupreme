/**
 * Embedding backfill (M12).
 *
 * This is the mechanism that makes the vector index DISPOSABLE (§2.3): because
 * D1 holds every question and only the derived vectors live in the index, the
 * index can be dropped entirely and rebuilt from here. The test suite does
 * exactly that to prove it.
 *
 * Re-embedding is skipped when `content_hash` is unchanged, so the common case
 * (nothing edited) costs one query rather than an embedding call.
 */

import { eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { nowMs, questionEmbeddings, questions } from "@/db/schema";
import { recordAudit } from "@/modules/audit";
import { embeddingContentHash, embeddingText, type Embedder } from "./embeddings";
import { vectorIdFor, type VectorIndex } from "./vector-index";

const MAX_BOUND_PARAMS = 90;
const EMBED_BATCH = 20;

export type BackfillResult = {
  scanned: number;
  embedded: number;
  skipped: number;
  indexed: number;
  failed: number;
};

export async function backfillEmbeddings(
  deps: { embedder: Embedder; index: VectorIndex },
  options: {
    limit?: number;
    actorId?: string | null;
    force?: boolean;
    statuses?: string[];
    /**
     * Whether to record the `question_embeddings` rows.
     *
     * Set FALSE when the index is throwaway (the in-memory development
     * fallback). Those rows are a claim that a vector exists at a given id, so
     * writing them while indexing into memory would leave the database
     * asserting something untrue — and coverage would report a bank that is
     * "embedded" when nothing can actually be queried.
     */
    persist?: boolean;
  } = {},
): Promise<BackfillResult> {
  const limit = Math.min(500, Math.max(1, options.limit ?? 100));
  const statuses = options.statuses ?? ["published"];
  const force = options.force ?? false;
  const persist = options.persist ?? true;

  const rows = await db()
    .select({
      id: questions.id,
      stem: questions.stem,
      status: questions.status,
      options: sql<string>`(
        select coalesce(group_concat(qo.body, ' | '), '')
        from question_options qo where qo.question_id = ${questions.id}
      )`,
    })
    .from(questions)
    .where(inArray(questions.status, statuses))
    .limit(limit);

  if (rows.length === 0) {
    return { scanned: 0, embedded: 0, skipped: 0, indexed: 0, failed: 0 };
  }

  // Which of these are already embedded with the CURRENT text?
  const ids = rows.map((row) => row.id);
  const existing = new Map<string, { contentHash: string; model: string }>();
  for (let i = 0; i < ids.length; i += MAX_BOUND_PARAMS) {
    const chunk = ids.slice(i, i + MAX_BOUND_PARAMS);
    const embeddingRows = await db()
      .select({
        questionId: questionEmbeddings.questionId,
        contentHash: questionEmbeddings.contentHash,
        model: questionEmbeddings.model,
      })
      .from(questionEmbeddings)
      .where(inArray(questionEmbeddings.questionId, chunk));
    for (const row of embeddingRows) {
      existing.set(row.questionId, { contentHash: row.contentHash, model: row.model });
    }
  }

  const pending: Array<{ id: string; text: string; contentHash: string }> = [];
  let skipped = 0;

  for (const row of rows) {
    const optionBodies = row.options ? row.options.split(" | ").filter(Boolean) : [];
    const text = embeddingText(row.stem, optionBodies);
    const contentHash = await embeddingContentHash(row.stem, optionBodies);
    const current = existing.get(row.id);

    if (!force && current && current.contentHash === contentHash && current.model === deps.embedder.model) {
      skipped += 1;
      continue;
    }
    pending.push({ id: row.id, text, contentHash });
  }

  const now = nowMs();
  let embedded = 0;
  let indexed = 0;
  let failed = 0;

  for (let i = 0; i < pending.length; i += EMBED_BATCH) {
    const batch = pending.slice(i, i + EMBED_BATCH);
    try {
      const vectors = await deps.embedder.embed(batch.map((item) => item.text));
      if (vectors.length !== batch.length) throw new Error("Embedding count mismatch.");

      const statusById = new Map(rows.map((row) => [row.id, row.status]));

      await deps.index.upsert(
        batch.map((item, offset) => ({
          id: vectorIdFor(item.id),
          values: vectors[offset]!,
          // The status travels WITH the vector so layer 3 can filter inside the
          // index instead of post-filtering a topK list.
          metadata: { questionId: item.id, status: statusById.get(item.id) ?? "published" },
        })),
      );
      indexed += batch.length;

      if (!persist) {
        embedded += batch.length;
        continue;
      }

      for (const [offset, item] of batch.entries()) {
        await db()
          .insert(questionEmbeddings)
          .values({
            questionId: item.id,
            model: deps.embedder.model,
            dimensions: vectors[offset]!.length,
            contentHash: item.contentHash,
            vectorizeId: vectorIdFor(item.id),
            createdAt: now,
          })
          .onConflictDoUpdate({
            target: [questionEmbeddings.questionId, questionEmbeddings.model],
            set: {
              contentHash: item.contentHash,
              dimensions: vectors[offset]!.length,
              vectorizeId: vectorIdFor(item.id),
              createdAt: now,
            },
          });
      }

      embedded += batch.length;
    } catch (error) {
      // A failed batch is reported, not fatal: the rest of the bank still gets
      // embedded and the backfill can simply be run again.
      console.error("Embedding batch failed", error);
      failed += batch.length;
    }
  }

  if (options.actorId && (embedded > 0 || failed > 0)) {
    await recordAudit(options.actorId, "dedupe.backfill", "question", null, null, {
      scanned: rows.length,
      embedded,
      skipped,
      failed,
    });
  }

  return { scanned: rows.length, embedded, skipped, indexed, failed };
}

/** How much of the bank is embedded, for the admin status panel. */
export async function embeddingCoverage(): Promise<{
  published: number;
  embedded: number;
}> {
  const published = (
    await db()
      .select({ n: sql<number>`count(*)` })
      .from(questions)
      .where(eq(questions.status, "published"))
  )[0];

  const embedded = (
    await db().select({ n: sql<number>`count(*)` }).from(questionEmbeddings)
  )[0];

  return { published: Number(published?.n ?? 0), embedded: Number(embedded?.n ?? 0) };
}
