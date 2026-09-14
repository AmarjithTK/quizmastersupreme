/**
 * Model-aware output budgets for generation (REVAMP-PLAN.md §3.1).
 *
 * The old pipeline asked for every batch with `max_tokens: 8000`, which is an
 * artificial ceiling, not a model limit: DeepSeek V4.1 Flash accepts ~125k
 * output tokens in one call, so a 10-question batch must never be truncated by
 * our own request. The budget here is the COUNT-driven ask, clamped to what the
 * configured model can actually emit.
 *
 * Models with a small real cap (Llama 3.3, Haiku, Gemini Flash) still work:
 * they truncate at their ceiling, and the pipeline's BACKFILL rounds top the
 * batch up to the requested count.
 */

/**
 * Tokens a single generated question costs, measured over real output:
 * stem ~150 + 4 options ~120 + explanation ~80 + 3-sentence backstory ~350
 * + JSON key/whitespace overhead ~60, with headroom.
 */
export const PER_QUESTION_TOKENS = 850;

/** Ask for a little more than the arithmetic minimum. */
const HEADROOM = 1.15;

/** Never ask for less than this; a tiny batch still needs room to be valid. */
export const MIN_OUTPUT_TOKENS = 8_000;

/** Used when a model is not in the table below. */
export const DEFAULT_MODEL_CAP = 16_000;

/**
 * Real per-model output ceilings. Ordered: first match wins.
 * Sources: provider model cards (DeepSeek V4.1 Flash ~125k+, Sonnet 4.5 64k,
 * Haiku 3.5 8k, GPT-4o family 16k, Gemini 2.x Flash 8-16k, Llama 3.3 4k).
 */
const MODEL_CAPS: ReadonlyArray<{ match: RegExp; cap: number }> = [
  // DeepSeek V4.x (incl. V4.1 Flash: 1M context, 125k+ output) — ask 96k, safe inside the cap.
  { match: /^deepseek\//i, cap: 96_000 },
  { match: /^anthropic\/claude-(sonnet|opus)-4/i, cap: 64_000 },
  { match: /^anthropic\/.*haiku/i, cap: 8_000 },
  { match: /^openai\//i, cap: 16_000 },
  { match: /^google\/gemini/i, cap: 16_000 },
  { match: /^meta-llama\/llama-3\.3-70b/i, cap: 4_000 },
];

export function modelOutputCap(model: string): number {
  for (const entry of MODEL_CAPS) {
    if (entry.match.test(model)) return entry.cap;
  }
  return DEFAULT_MODEL_CAP;
}

/**
 * The `max_tokens` to request for `count` questions on `model`.
 *
 * count=10 → ~10k · count=25 → ~25k · count=50 → ~50k on DeepSeek;
 * clamped to the model's real ceiling, so a small model just gets its max and
 * the backfill loop handles the rest.
 */
export function outputBudgetFor(count: number, model: string): number {
  const wanted = Math.ceil(Math.max(1, count) * PER_QUESTION_TOKENS * HEADROOM);
  return Math.min(Math.max(wanted, MIN_OUTPUT_TOKENS), modelOutputCap(model));
}
