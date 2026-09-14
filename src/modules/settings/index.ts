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
  /** Jaccard at or above this is treated as near-identical and auto-filtered. */
  jaccardReject: number;
  /** Jaccard at or above this (but below reject) is shown as a possible duplicate. */
  jaccardReview: number;
};

/**
 * Starting values, measured on the seed corpus rather than guessed.
 */
export const DEDUPE_DEFAULTS: DedupeThresholds = {
  jaccardReject: 0.85,
  jaccardReview: 0.65,
};

const KEYS: Record<keyof DedupeThresholds, string> = {
  jaccardReject: "dedupe.jaccard_reject",
  jaccardReview: "dedupe.jaccard_review",
};

function coerce(key: keyof DedupeThresholds, raw: string): number | null {
  try {
    const value = JSON.parse(raw);
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    // Guard the obviously wrong: a similarity outside 0..1 is a typo.
    if (value < 0 || value > 1) return null;
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

// ── AI generation settings (provider + model) ─────────────────────────────────

/**
 * The provider is deliberately locked to OpenRouter. The pipeline is provider-
 * agnostic (an `LlmProvider`), but this settings screen only ever offers
 * OpenRouter — one provider, one key, fewer surprises. Swap the value here and
 * the adapter in `modules/ai` if that ever changes.
 */
export const AI_PROVIDERS = ["openrouter"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

export const DEFAULT_AI_MODEL = "deepseek/deepseek-v4.1-flash";

export const AI_MODEL_PRESETS = [
  "deepseek/deepseek-v4.1-flash",
  "deepseek/deepseek-v4-flash-0731",
  "deepseek/deepseek-chat-v3-0324",
  "anthropic/claude-sonnet-4.5",
  "anthropic/claude-3.5-haiku",
  "openai/gpt-4o-mini",
  "meta-llama/llama-3.3-70b-instruct",
  "google/gemini-2.0-flash-001",
] as const;

export type AiGenerationSettings = {
  provider: AiProvider;
  model: string;
};

const AI_PROVIDER_KEY = "ai.provider";
const AI_MODEL_KEY = "ai.model";

export async function getAiGenerationSettings(): Promise<AiGenerationSettings> {
  const rows = await db()
    .select({ key: appSettings.key, value: appSettings.value })
    .from(appSettings)
    .where(inArray(appSettings.key, [AI_PROVIDER_KEY, AI_MODEL_KEY]));

  const stored = new Map(rows.map((row) => [row.key, row.value]));
  const providerRaw = stored.get(AI_PROVIDER_KEY);
  const modelRaw = stored.get(AI_MODEL_KEY);

  const provider: AiProvider = AI_PROVIDERS.includes(providerRaw as AiProvider)
    ? (providerRaw as AiProvider)
    : "openrouter";

  // Values are stored JSON-encoded (setSetting JSON.stringifies), so unwrap.
  function unwrap(raw: string | undefined): string | null {
    if (raw == null) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === "string" ? parsed : null;
    } catch {
      return raw.trim().length > 0 ? raw.trim() : null;
    }
  }

  const model = unwrap(modelRaw) ?? DEFAULT_AI_MODEL;

  return { provider, model };
}

export async function updateAiGenerationSettings(
  patch: Partial<AiGenerationSettings>,
  actorId: string,
): Promise<AiGenerationSettings> {
  if (patch.provider !== undefined) {
    if (!AI_PROVIDERS.includes(patch.provider)) {
      throw new Error(`Unsupported provider "${patch.provider}". Only OpenRouter is available.`);
    }
    await setSetting(AI_PROVIDER_KEY, patch.provider, actorId);
  }
  if (patch.model !== undefined) {
    const model = patch.model.trim();
    if (!model) throw new Error("Model name cannot be empty.");
    await setSetting(AI_MODEL_KEY, model, actorId);
  }
  return getAiGenerationSettings();
}

// ── OpenRouter provider routing (provider.only / provider.order) ─────────────

export type ProviderRouting = {
  /** Allow-list of provider slugs. Empty = any provider may serve. */
  only: string[];
  /** Priority order of provider slugs. Empty = OpenRouter default order. */
  order: string[];
};

const ROUTING_ONLY_KEY = "ai.provider_only";
const ROUTING_ORDER_KEY = "ai.provider_order";

function parseSlugList(raw: string | undefined): string[] {
  if (raw == null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((x): x is string => typeof x === "string" && /^[a-z0-9][a-z0-9_-]*$/.test(x));
    }
  } catch {
    // fall through
  }
  return [];
}

export async function getProviderRouting(): Promise<ProviderRouting> {
  const rows = await db()
    .select({ key: appSettings.key, value: appSettings.value })
    .from(appSettings)
    .where(inArray(appSettings.key, [ROUTING_ONLY_KEY, ROUTING_ORDER_KEY]));
  const stored = new Map(rows.map((row) => [row.key, row.value]));
  return { only: parseSlugList(stored.get(ROUTING_ONLY_KEY)), order: parseSlugList(stored.get(ROUTING_ORDER_KEY)) };
}

/**
 * Persist routing. Slugs are validated (lowercase, `[a-z0-9_-]`); duplicates
 * are dropped. Only the two allowed shapes are ever written — nothing else in
 * the OpenRouter routing schema is touched (no sorting/latency/pricing).
 *
 * HARD RULE: `only` and `order` are mutually exclusive — pick ONE mode. Sending
 * both is rejected because a routing that is both an allow-list AND a priority
 * list is the quickest way to get unpredictable costs, which is the exact
 * problem this setting exists to solve.
 */
export async function updateProviderRouting(
  patch: Partial<ProviderRouting>,
  actorId: string,
): Promise<ProviderRouting> {
  const clean = (slugs: string[] | undefined): string[] | undefined => {
    if (slugs === undefined) return undefined;
    const uniq = [...new Set(slugs.map((s) => s.trim().toLowerCase()).filter(Boolean))];
    for (const slug of uniq) {
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(slug)) {
        throw new Error(`Invalid provider slug "${slug}".`);
      }
    }
    return uniq;
  };

  const only = clean(patch.only);
  const order = clean(patch.order);

  if (only && only.length > 0 && order && order.length > 0) {
    throw new Error("Pick one routing mode: provider.only OR provider.order, not both.");
  }

  if (only !== undefined && order !== undefined) {
    // Both fields given (the UI always sends both): they express the FULL
    // routing state — either exactly one is non-empty, or both are empty.
    await setSetting(ROUTING_ONLY_KEY, only, actorId);
    await setSetting(ROUTING_ORDER_KEY, order, actorId);
  } else if (only !== undefined) {
    // Picking `only` clears `order`.
    await setSetting(ROUTING_ONLY_KEY, only, actorId);
    await setSetting(ROUTING_ORDER_KEY, [], actorId);
  } else if (order !== undefined) {
    // Picking `order` clears `only`.
    await setSetting(ROUTING_ORDER_KEY, order, actorId);
    await setSetting(ROUTING_ONLY_KEY, [], actorId);
  }
  return getProviderRouting();
}
