/**
 * Embeddings for dedupe layer 3 (M12).
 *
 * The `Embedder` interface exists for the same reason `LlmProvider` does: the
 * real one needs a Workers AI binding and a network round trip, and the tests
 * need neither. It also means the embedder can be swapped without touching the
 * dedupe logic.
 *
 * WHAT IS EMBEDDED MATTERS: the stem plus the option bodies. NOT the backstory
 * — backstories are long prose about the same topic, so including them makes
 * unrelated questions look alike and quietly poisons the similarity scores.
 */

import { normalizeStem } from "@/modules/questions/normalize";

export interface Embedder {
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

export class EmbeddingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingError";
  }
}

/** The text that actually gets embedded. */
export function embeddingText(stem: string, optionBodies: readonly string[]): string {
  return [stem, ...optionBodies].join(" \n ");
}

/** Content hash of the embedded text, so we only re-embed when it changes. */
export async function embeddingContentHash(
  stem: string,
  optionBodies: readonly string[],
): Promise<string> {
  const { sha256Hex } = await import("@/lib/crypto");
  return sha256Hex(embeddingText(stem, optionBodies));
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Workers AI adapter.
 *
 * The binding is passed in rather than read from `bindings()` so this module
 * stays free of the Workers runtime.
 */
export function workersAiEmbedder(
  ai: { run(model: string, input: unknown): Promise<unknown> },
  model: string,
  dimensions = 1024,
): Embedder {
  return {
    model,
    dimensions,
    async embed(texts) {
      if (texts.length === 0) return [];
      try {
        const result = (await ai.run(model, { text: texts })) as { data?: number[][] };
        const data = result?.data;
        if (!Array.isArray(data) || data.length !== texts.length) {
          throw new EmbeddingError("The embedding model returned an unexpected shape.");
        }
        return data;
      } catch (error) {
        if (error instanceof EmbeddingError) throw error;
        throw new EmbeddingError(
          error instanceof Error ? error.message : "The embedding model call failed.",
        );
      }
    },
  };
}

/**
 * Deterministic feature-hashing embedder.
 *
 * Used by tests and by local development, where no Workers AI binding exists.
 * It is NOT a semantic model: it hashes word tokens into buckets, so two texts
 * sharing vocabulary land close together and unrelated texts do not. That is
 * enough to exercise the plumbing, the thresholds, the backfill and the
 * degradation paths honestly — and it is why the real embedder is a one-line
 * swap rather than a rewrite.
 */
export function featureHashEmbedder(options: { dimensions?: number; seed?: number } = {}): Embedder {
  const dimensions = options.dimensions ?? 256;
  const seed = options.seed ?? 0x9e3779b9;

  function hash(token: string): number {
    let h = seed;
    for (let i = 0; i < token.length; i++) {
      h ^= token.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  return {
    model: "feature-hash-v1",
    dimensions,
    async embed(texts) {
      return texts.map((text) => {
        const vector = new Array<number>(dimensions).fill(0);
        for (const token of normalizeStem(text).split(/\s+/)) {
          if (token.length === 0) continue;
          // Signed hashing keeps collisions from systematically inflating
          // similarity the way plain counting would.
          const h = hash(token);
          const index = h % dimensions;
          const sign = (h >>> 31) & 1 ? -1 : 1;
          vector[index] = (vector[index] ?? 0) + sign;
        }
        // L2-normalise so cosine similarity is scale-free.
        const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
        return norm === 0 ? vector : vector.map((value) => value / norm);
      });
    },
  };
}
