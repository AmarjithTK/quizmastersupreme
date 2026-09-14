/**
 * Model pricing + cost estimates.
 *
 * Deliberately dependency-free (no db, no bindings, no logger) so CLIENT
 * components can import it for the generate screen's cost hint. The pipeline
 * uses the same functions, which keeps one price table for the whole app.
 */

/** Per-million-token list prices, used only to record an estimated cost. */
export const PRICE_PER_MILLION: Record<string, { input: number; output: number }> = {
  // DeepSeek. V4 Flash 0731 is the cheap workhorse: ~$0.0015 for a
  // 25-question batch, which is why batching quality beats minimising call
  // count (PIPELINE-PLAN.md §0).
  "deepseek/deepseek-v4.1-flash": { input: 0.15, output: 0.6 },
  "deepseek/deepseek-v4-flash-0731": { input: 0.05, output: 0.16 },
  // Unknown model: deliberately high so cost is never silently under-reported.
  default: { input: 3, output: 15 },
};

export function priceFor(model: string): { input: number; output: number } {
  return PRICE_PER_MILLION[model] ?? PRICE_PER_MILLION.default!;
}

export function estimateCostUsd(
  model: string,
  promptTokens: number | null,
  completionTokens: number | null,
): number | null {
  if (promptTokens == null && completionTokens == null) return null;
  const price = priceFor(model);
  const input = ((promptTokens ?? 0) / 1_000_000) * price.input;
  const output = ((completionTokens ?? 0) / 1_000_000) * price.output;
  return Math.round((input + output) * 1_000_000) / 1_000_000;
}

/**
 * Rough cost of a job BEFORE it runs, for the generate screen's hint.
 *
 * Deliberately approximate: it assumes ~850 output tokens per question, ~6k
 * input tokens of shared context per call (digest + source pool + concepts) and
 * 25% refill slack. Real cost is summed from measured tokens per batch.
 */
export function estimateJobCostUsd(count: number, batchSize: number, model: string): number {
  const price = priceFor(model);
  const batches = Math.max(1, Math.ceil(count / Math.max(1, batchSize)) * 1.25);
  const inputTokensPerCall = 6_000;
  const outputTokensPerCall = Math.min(batchSize * 850, 16_000);
  const perCall =
    (inputTokensPerCall * price.input + outputTokensPerCall * price.output) / 1_000_000;
  return Math.round(perCall * batches * 1_000_000) / 1_000_000;
}

/** The one-off search fee by engine, on top of the research call's tokens. */
export const SEARCH_REQUEST_COST: Record<string, number> = {
  exa: 0.007,
  parallel: 0.005,
  perplexity: 0.005,
};
