/**
 * LLM provider abstraction (M10).
 *
 * The pipeline never talks to a vendor directly. It takes an `LlmProvider`, so:
 *   - production uses OpenRouter,
 *   - the test suite uses a stub and needs no API key and no network,
 *   - swapping vendors later is one new file, not a rewrite.
 *
 * This is also why nothing here reads bindings: the caller resolves the
 * provider and passes it in.
 */

export type GenerationRequest = {
  model: string;
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
};

export type GenerationResponse = {
  /** The model's raw text output, untouched. */
  text: string;
  model: string;
  promptTokens: number | null;
  completionTokens: number | null;
  /** The provider's own payload, for R2 archival and debugging. */
  raw: unknown;
};

export interface LlmProvider {
  readonly name: string;
  generate(request: GenerationRequest): Promise<GenerationResponse>;
}

export class LlmError extends Error {
  readonly code: string;
  readonly status: number | null;
  /** Whether retrying the same request could plausibly succeed. */
  readonly retryable: boolean;

  constructor(message: string, options: { code: string; status?: number | null; retryable?: boolean }) {
    super(message);
    this.name = "LlmError";
    this.code = options.code;
    this.status = options.status ?? null;
    this.retryable = options.retryable ?? false;
  }
}

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

/** Rough per-million-token prices, used only to record an estimated cost. */
const PRICE_PER_MILLION: Record<string, { input: number; output: number }> = {
  default: { input: 3, output: 15 },
};

export function estimateCostUsd(
  model: string,
  promptTokens: number | null,
  completionTokens: number | null,
): number | null {
  if (promptTokens == null && completionTokens == null) return null;
  const price = PRICE_PER_MILLION[model] ?? PRICE_PER_MILLION.default!;
  const input = ((promptTokens ?? 0) / 1_000_000) * price.input;
  const output = ((completionTokens ?? 0) / 1_000_000) * price.output;
  return Math.round((input + output) * 1_000_000) / 1_000_000;
}

export function openRouterProvider(options: {
  apiKey: string;
  referer?: string;
  title?: string;
  fetchImpl?: typeof fetch;
}): LlmProvider {
  const doFetch = options.fetchImpl ?? fetch;

  return {
    name: "openrouter",
    async generate(request) {
      const response = await doFetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json",
          ...(options.referer ? { "HTTP-Referer": options.referer } : {}),
          ...(options.title ? { "X-Title": options.title } : {}),
        },
        body: JSON.stringify({
          model: request.model,
          messages: [
            { role: "system", content: request.system },
            { role: "user", content: request.user },
          ],
          temperature: request.temperature ?? 0.7,
          max_tokens: request.maxTokens ?? 8000,
          // Ask for JSON where the model supports it; the parser copes when it
          // does not, so this is an optimisation rather than a requirement.
          response_format: { type: "json_object" },
        }),
      });

      const bodyText = await response.text();

      if (!response.ok) {
        // 429 and 5xx are worth retrying; 4xx generally are not.
        const retryable = response.status === 429 || response.status >= 500;
        throw new LlmError(`The model provider returned ${response.status}.`, {
          code: response.status === 429 ? "RATE_LIMITED" : "PROVIDER_ERROR",
          status: response.status,
          retryable,
        });
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(bodyText);
      } catch {
        throw new LlmError("The model provider returned a non-JSON response.", {
          code: "BAD_PROVIDER_RESPONSE",
        });
      }

      const payload = parsed as {
        model?: string;
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };

      const text = payload.choices?.[0]?.message?.content;
      if (typeof text !== "string" || text.trim() === "") {
        throw new LlmError("The model returned an empty response.", { code: "EMPTY_RESPONSE" });
      }

      return {
        text,
        model: payload.model ?? request.model,
        promptTokens: payload.usage?.prompt_tokens ?? null,
        completionTokens: payload.usage?.completion_tokens ?? null,
        raw: parsed,
      };
    },
  };
}

/**
 * Deterministic provider for tests and local dry runs.
 *
 * `respond` is given the request and returns the text the "model" would have
 * produced, so a test can drive any scenario — valid JSON, truncated JSON,
 * prose-wrapped JSON, a wrong option count — without a network call.
 */
export function stubProvider(
  respond: (request: GenerationRequest) => string | Promise<string>,
): LlmProvider {
  return {
    name: "stub",
    async generate(request) {
      const text = await respond(request);
      return {
        text,
        model: request.model,
        promptTokens: Math.ceil((request.system.length + request.user.length) / 4),
        completionTokens: Math.ceil(text.length / 4),
        raw: { stub: true },
      };
    },
  };
}
