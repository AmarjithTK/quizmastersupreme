/**
 * Runtime settings (M11).
 *
 * Dedupe thresholds live in the database rather than in code because they are
 * empirical: the right Jaccard cut for exam questions is discovered by looking
 * at real flagged pairs, not by reasoning about it. A deploy to change a number
 * would make tuning impractical, so it is a row.
 *
 * Reads are cheap (one query for all keys) and callers that need several values
 * fetch them together.
 */

import { inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { appSettings, nowMs } from "@/db/schema";
import { recordAudit } from "@/modules/audit";

export type DedupeThresholds = {
  /** Jaccard at or above this is treated as near-identical. */
  jaccardReject: number;
  /** Jaccard at or above this (but below reject) needs a human look. */
  jaccardReview: number;
  /** SimHash Hamming distance treated as "near". */
  simhashMaxDistance: number;
  /** Cosine similarity at or above this is a semantic duplicate (M12). */
  semanticReject: number;
  /** Cosine at or above this (but below reject) needs a human look (M12). */
  semanticReview: number;
};

/**
 * Starting values, measured on the seed corpus rather than guessed.
 * See the band table in modules/dedupe/simhash.ts.
 */
export const DEDUPE_DEFAULTS: DedupeThresholds = {
  jaccardReject: 0.85,
  jaccardReview: 0.65,
  simhashMaxDistance: 16,
  semanticReject: 0.95,
  semanticReview: 0.85,
};

const KEYS: Record<keyof DedupeThresholds, string> = {
  jaccardReject: "dedupe.jaccard_reject",
  jaccardReview: "dedupe.jaccard_review",
  simhashMaxDistance: "dedupe.simhash_max_distance",
  semanticReject: "dedupe.semantic_reject",
  semanticReview: "dedupe.semantic_review",
};

function coerce(key: keyof DedupeThresholds, raw: string): number | null {
  try {
    const value = JSON.parse(raw);
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    // Guard the obviously wrong: a similarity outside 0..1 is a typo.
    if (key !== "simhashMaxDistance" && (value < 0 || value > 1)) return null;
    if (key === "simhashMaxDistance" && (value < 0 || value > 64)) return null;
    return value;
  } catch {
    return null;
  }
}

export async function getDedupeThresholds(): Promise<DedupeThresholds> {
  const rows = await db()
    .select({ key: appSettings.key, value: appSettings.value })
    .from(appSettings)
    .where(inArray(appSettings.key, Object.values(KEYS)));

  const stored = new Map(rows.map((row) => [row.key, row.value]));
  const result = { ...DEDUPE_DEFAULTS };

  for (const [field, key] of Object.entries(KEYS) as Array<[keyof DedupeThresholds, string]>) {
    const raw = stored.get(key);
    if (raw === undefined) continue;
    const parsed = coerce(field, raw);
    if (parsed !== null) result[field] = parsed;
  }

  return result;
}

export async function setSetting(
  key: string,
  value: unknown,
  actorId: string,
): Promise<void> {
  const now = nowMs();
  await db()
    .insert(appSettings)
    .values({ key, value: JSON.stringify(value), updatedAt: now, updatedBy: actorId })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value: JSON.stringify(value), updatedAt: now, updatedBy: actorId },
    });

  await recordAudit(actorId, "settings.update", "setting", key, null, { value });
}

export async function updateDedupeThresholds(
  patch: Partial<DedupeThresholds>,
  actorId: string,
): Promise<DedupeThresholds> {
  for (const [field, value] of Object.entries(patch) as Array<
    [keyof DedupeThresholds, number | undefined]
  >) {
    if (value === undefined) continue;
    if (coerce(field, JSON.stringify(value)) === null) {
      throw new Error(`Invalid value for ${field}.`);
    }
    await setSetting(KEYS[field], value, actorId);
  }
  return getDedupeThresholds();
}

export async function listSettings(): Promise<Array<{ key: string; value: string; updatedAt: number }>> {
  return db()
    .select({ key: appSettings.key, value: appSettings.value, updatedAt: appSettings.updatedAt })
    .from(appSettings)
    .orderBy(appSettings.key);
}

export { KEYS as DEDUPE_SETTING_KEYS };
