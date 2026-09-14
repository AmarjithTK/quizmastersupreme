/**
 * Text normalization — the foundation of dedupe layer 1.
 * PLAN.md §13.2.
 *
 * This is deliberately dependency-free and synchronous so it can run in the
 * hot path of every question write, and be unit-tested trivially.
 */

/**
 * Normalize a question stem to a canonical form for exact-duplicate hashing.
 *
 * "Who created Linux?" and "who created linux" must collapse to one string.
 * NFKC first so that visually identical Unicode forms compare equal.
 */
export function normalizeStem(input: string): string {
  return (
    input
      .normalize("NFKC")
      .toLowerCase()
      // Fold typographic quotes onto ASCII first...
      .replace(/[\u2018\u2019\u201C\u201D\u02BC]/g, "'")
      // ...then DELETE apostrophes rather than treating them as separators, so
      // "Kerala's" and "Keralas" normalize to the same string. Turning them into
      // spaces would give "kerala s" vs "keralas" and defeat layer 1.
      .replace(/'/g, "")
      // Keep letters, numbers AND combining marks. \p{M} is load-bearing:
      // Indic vowel signs and anusvaras are Marks, not Letters, so omitting it
      // silently corrupts Malayalam/Hindi/Tamil stems into broken text.
      .replace(/[^\p{L}\p{N}\p{M}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/** Same normalization, named separately so intent is clear at call sites. */
export function normalizeOptionBody(input: string): string {
  return normalizeStem(input);
}

/**
 * Fingerprint of stem + the SORTED set of option bodies.
 *
 * Sorting means reordering options does not produce a different fingerprint —
 * which is correct, because shuffling options makes no semantic difference.
 */
export function contentFingerprint(stem: string, optionBodies: readonly string[]): string {
  const sortedOptions = optionBodies.map(normalizeOptionBody).sort();
  return [normalizeStem(stem), ...sortedOptions].join("|");
}

/** sha256 as lowercase hex. Re-exported from `lib/crypto` so that `modules/auth`
 *  can use the same primitive without importing another domain module (§2.4). */
import { sha256Hex } from "@/lib/crypto";
export { sha256Hex };

/**
 * The three layer-1 hashes stored on every question.
 * Kept together so a write path cannot compute one and forget the others.
 */
export async function computeDedupeHashes(
  stem: string,
  optionBodies: readonly string[],
): Promise<{ normalizedHash: string; contentHash: string }> {
  return {
    normalizedHash: await sha256Hex(normalizeStem(stem)),
    contentHash: await sha256Hex(contentFingerprint(stem, optionBodies)),
  };
}

/** Slugify a title for use in category/set slugs. */
export function slugify(input: string): string {
  return normalizeStem(input).replace(/\s+/g, "-");
}
