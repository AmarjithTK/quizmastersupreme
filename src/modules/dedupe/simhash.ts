/**
 * 64-bit SimHash — dedupe layer 2's near-duplicate prefilter.
 * PLAN.md §13.3.
 *
 * Pure TypeScript over BigInt: no dependencies, no WASM, no native module.
 * Every question stores its simhash, so a bank-wide scan is a linear pass with
 * a popcount — cheap enough to run inside a queue consumer, and unnecessary in
 * the user-facing hot path.
 */

import { normalizeStem } from "@/modules/questions/normalize";

const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

/** FNV-1a, 64-bit, over UTF-8 bytes. */
export function fnv1a64(input: string): bigint {
  let hash = FNV_OFFSET_BASIS;
  for (const byte of new TextEncoder().encode(input)) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & MASK_64;
  }
  return hash;
}

/** Overlapping token n-grams. Word 3-grams capture local phrasing. */
export function shingles(text: string, size = 3): string[] {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  if (tokens.length < size) return [tokens.join(" ")];
  const out: string[] = [];
  for (let i = 0; i + size <= tokens.length; i++) {
    out.push(tokens.slice(i, i + size).join(" "));
  }
  return out;
}

/**
 * Characteristic 64-bit SimHash of a question stem.
 *
 * Uses WORD UNIGRAMS, not n-grams. Question stems are short (typically 5–15
 * tokens), and with so few 3-grams a single changed word perturbs most of the
 * grams — measurably pushing a one-word spelling variant ~23 bits away, which
 * is useless as a near-duplicate signal. Unigrams keep one changed word to one
 * changed feature.
 *
 * This is a coarse PREFILTER for cheap bank-wide sweeps. FTS5 + Jaccard does
 * the real work at layer 2, and embeddings do the semantic work at layer 3.
 */
export function simhash64(text: string): bigint {
  const votes = new Array<number>(64).fill(0);
  for (const gram of shingles(normalizeStem(text), 1)) {
    const h = fnv1a64(gram);
    for (let i = 0; i < 64; i++) {
      const bit = (h >> BigInt(i)) & 1n;
      // Explicit local: `votes[i] += ...` trips noUncheckedIndexedAccess.
      votes[i] = (votes[i] ?? 0) + (bit === 1n ? 1 : -1);
    }
  }
  let out = 0n;
  for (let i = 0; i < 64; i++) {
    if ((votes[i] ?? 0) > 0) out |= 1n << BigInt(i);
  }
  return out;
}

export function hammingDistance(a: bigint, b: bigint): number {
  let x = a ^ b;
  let count = 0;
  while (x > 0n) {
    count += Number(x & 1n);
    x >>= 1n;
  }
  return count;
}

export function toHex64(value: bigint): string {
  return value.toString(16).padStart(16, "0");
}

export function fromHex64(hex: string): bigint {
  return BigInt(`0x${hex}`);
}

/** Store as 16 lowercase hex chars so SQLite can compare and index it. */
export function simhashHex(text: string): string {
  return toHex64(simhash64(text));
}

/**
 * Measured Hamming-distance bands on real question stems (see tests):
 *
 *   identical / case+punct only .......  0
 *   one-word spelling variant ......... 10
 *   paraphrase ........................ 12
 *   same topic, different fact ........ 24
 *   different topic ................... 28
 *   unrelated ......................... 36
 *
 * 16 sits in the gap between "near" and "far" with margin on both sides. This
 * is a coarse prefilter only — the authoritative thresholds used for review
 * decisions live in `app_settings` (§13.4) so they can be tuned without a deploy.
 */
export const SIMHASH_NEAR_DUPLICATE_MAX_DISTANCE = 16;
