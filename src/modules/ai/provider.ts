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
  /**
   * OpenRouter provider routing (provider.only / provider.order).
   * `only` is the allow-list of provider slugs; `order` is their priority.
   */
  providerOnly?: string[];
  providerOrder?: string[];
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

import { logError, logInfo, logWarn, logException, maskSecret } from "@/lib/logger";

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
      logInfo("provider", `calling ${request.model}`, {
        url: OPENROUTER_URL,
        apiKey: maskSecret(options.apiKey),
        temperature: request.temperature ?? 0.7,
        maxTokens: request.maxTokens ?? 8000,
        promptChars: request.system.length + request.user.length,
        providerOnly: request.providerOnly ?? [],
        providerOrder: request.providerOrder ?? [],
      });

      // provider.routing is added ONLY when the arrays are present — an empty
      // object would override OpenRouter's default routing.
      const providerRouting =
        (request.providerOnly?.length ?? 0) > 0 || (request.providerOrder?.length ?? 0) > 0
          ? {
              ...(request.providerOnly && request.providerOnly.length > 0
                ? { only: request.providerOnly }
                : {}),
              ...(request.providerOrder && request.providerOrder.length > 0
                ? { order: request.providerOrder }
                : {}),
            }
          : undefined;

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
          ...(providerRouting ? { provider: providerRouting } : {}),
        }),
      });

      const bodyText = await response.text();

      if (!response.ok) {
        // 429 and 5xx are worth retrying; 4xx generally are not.
        const retryable = response.status === 429 || response.status >= 500;
        logError("provider", `HTTP ${response.status} from provider`, {
          retryable,
          bodySnippet: bodyText.slice(0, 500),
        });
        throw new LlmError(`The model provider returned ${response.status}.`, {
          code: response.status === 429 ? "RATE_LIMITED" : "PROVIDER_ERROR",
          status: response.status,
          retryable,
        });
      }

      logInfo("provider", `HTTP ${response.status} received`, {
        bytes: bodyText.length,
      });

      let parsed: unknown;
      try {
        parsed = JSON.parse(bodyText);
      } catch {
        logError("provider", "non-JSON response body", {
          snippet: bodyText.slice(0, 500),
        });
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
        logWarn("provider", "empty response content", {
          keys: Object.keys(parsed as object),
          choices: (parsed as { choices?: unknown[] })?.choices?.length ?? 0,
        });
        throw new LlmError("The model returned an empty response.", { code: "EMPTY_RESPONSE" });
      }

      logInfo("provider", "response ok", {
        model: payload.model ?? request.model,
        promptTokens: payload.usage?.prompt_tokens ?? null,
        completionTokens: payload.usage?.completion_tokens ?? null,
        contentChars: text.length,
      });

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
      logInfo("provider", "stub response", { model: request.model, chars: text.length });
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
