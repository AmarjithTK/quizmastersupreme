/**
 * Vector index abstraction for dedupe layer 3 (M12).
 *
 * D1 remains the source of truth; this index is DISPOSABLE (§2.3). It stores
 * nothing but `vector_id → question_id` plus the vector, so it can be deleted
 * and rebuilt from D1 at any time — and the test suite proves exactly that.
 *
 * `memoryVectorIndex` is a real brute-force cosine index, not a mock: the tests
 * exercise genuine nearest-neighbour behaviour without a Vectorize account.
 */

export type VectorRecord = {
  id: string;
  values: number[];
  metadata?: Record<string, unknown>;
};

export type VectorMatch = {
  id: string;
  score: number;
  metadata?: Record<string, unknown>;
};

export interface VectorIndex {
  readonly name: string;
  upsert(records: VectorRecord[]): Promise<void>;
  query(
    values: number[],
    options?: { topK?: number; filter?: Record<string, unknown> },
  ): Promise<VectorMatch[]>;
  deleteByIds(ids: string[]): Promise<void>;
  /** How many vectors the index currently holds (used by tests and status UI). */
  size(): Promise<number>;
}

/** Vector ids are prefixed so a raw index dump is still human-readable. */
export function vectorIdFor(questionId: string): string {
  return `q_${questionId}`;
}

export function questionIdFromVectorId(vectorId: string): string {
  return vectorId.startsWith("q_") ? vectorId.slice(2) : vectorId;
}

/**
 * Brute-force cosine index held in memory.
 *
 * O(n) per query, which is fine for tests and for a bank in the low thousands —
 * and it is a useful reference implementation for what Vectorize does.
 */
export function memoryVectorIndex(): VectorIndex {
  const store = new Map<string, VectorRecord>();

  function matchesFilter(record: VectorRecord, filter?: Record<string, unknown>): boolean {
    if (!filter) return true;
    for (const [key, expected] of Object.entries(filter)) {
      if (record.metadata?.[key] !== expected) return false;
    }
    return true;
  }

  return {
    name: "memory",
    async upsert(records) {
      for (const record of records) store.set(record.id, record);
    },
    async query(values, options = {}) {
      const topK = options.topK ?? 5;
      const results: VectorMatch[] = [];

      for (const record of store.values()) {
        if (!matchesFilter(record, options.filter)) continue;
        let dot = 0;
        let normA = 0;
        let normB = 0;
        for (let i = 0; i < values.length; i++) {
          const a = values[i] ?? 0;
          const b = record.values[i] ?? 0;
          dot += a * b;
          normA += a * a;
          normB += b * b;
        }
        const score =
          normA === 0 || normB === 0 ? 0 : dot / (Math.sqrt(normA) * Math.sqrt(normB));
        results.push({ id: record.id, score, metadata: record.metadata });
      }

      return results.sort((a, b) => b.score - a.score).slice(0, topK);
    },
    async deleteByIds(ids) {
      for (const id of ids) store.delete(id);
    },
    async size() {
      return store.size;
    },
  };
}

/**
 * Cloudflare Vectorize adapter.
 *
 * Note the metadata filter: layer 3 must only compare against PUBLISHED
 * questions. Post-filtering a topK list would silently lose matches as the
 * bank grows, which is why the index carries a `status` metadata field and a
 * metadata index is created for it in the deploy steps.
 */
export function vectorizeIndex(
  binding: {
    upsert(vectors: VectorRecord[]): Promise<unknown>;
    query(
      values: number[],
      options?: { topK?: number; returnMetadata?: string; filter?: Record<string, unknown> },
    ): Promise<{ matches?: Array<{ id: string; score: number; metadata?: Record<string, unknown> }> }>;
    deleteByIds(ids: string[]): Promise<unknown>;
  },
  name = "quizmaster-supreme-questions",
): VectorIndex {
  return {
    name,
    async upsert(records) {
      await binding.upsert(records);
    },
    async query(values, options = {}) {
      const response = await binding.query(values, {
        topK: options.topK ?? 5,
        returnMetadata: "all",
        ...(options.filter ? { filter: options.filter } : {}),
      });
      return (response.matches ?? []).map((match) => ({
        id: match.id,
        score: match.score,
        metadata: match.metadata,
      }));
    },
    async deleteByIds(ids) {
      await binding.deleteByIds(ids);
    },
    async size() {
      // Vectorize exposes no count; the caller tracks it in D1 instead.
      return -1;
    },
  };
}
