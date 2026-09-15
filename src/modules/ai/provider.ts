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
  /** Strict provider-side JSON Schema when the selected route supports it. */
  responseSchema?: {
    name: string;
    schema: Record<string, unknown>;
    strict?: boolean;
  };
  /**
   * OpenRouter provider routing (provider.only / provider.order).
   * `only` is the allow-list of provider slugs; `order` is their priority.
   */
  providerOnly?: string[];
  providerOrder?: string[];
  /**
   * OpenRouter plugins, passed through verbatim. Used by the grounding stage
   * for the `web` plugin (`{ id: "web", engine: "exa", max_results: 5 }`).
   * Generation calls never set this: the search fee is per REQUEST, so grounding
   * happens once per job into a shared source pool (PIPELINE-PLAN.md §8).
   */
  plugins?: Array<Record<string, unknown>>;
  /** OpenRouter server tools, including the current web-search tool. */
  tools?: Array<Record<string, unknown>>;
};

/** One grounded source, as OpenRouter standardises it into `url_citation`. */
export type UrlCitation = {
  url: string;
  title?: string;
  content?: string;
};

export type GenerationResponse = {
  /** The model's raw text output, untouched. */
  text: string;
  model: string;
  promptTokens: number | null;
  completionTokens: number | null;
  /** Provider termination reason (`stop`, `length`, …), when supplied. */
  finishReason?: string | null;
  /** Web-search citations, when the request used the `web` plugin. */
  citations?: UrlCitation[];
  /** The provider's own payload, for R2 archival and debugging. */
  raw: unknown;
};

export interface LlmProvider {
  readonly name: string;
  generate(request: GenerationRequest): Promise<GenerationResponse>;
}

import { logError, logInfo, logWarn, logException, maskSecret } from "@/lib/logger";
import { estimateCostUsd } from "@/lib/pricing";

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
const MAX_PROVIDER_BODY_BYTES = 2_000_000;

async function boundedProviderBody(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < MAX_PROVIDER_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      const available = Math.min(value.byteLength, MAX_PROVIDER_BODY_BYTES - size);
      chunks.push(value.subarray(0, available));
      size += available;
      if (available < value.byteLength) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(joined);
}

/**
 * Fallback output budget when a caller does not supply one. The pipeline always
 * supplies a count-derived budget (see `budget.ts`), so this only covers direct
 * or future callers.
 */
export const DEFAULT_MAX_TOKENS = 16_000;

// Pricing lives in `@/lib/pricing` so the CLIENT generate screen can show a
// cost hint without importing this server module. Re-exported here because the
// pipeline has always imported it from the provider.
export { estimateCostUsd, estimateJobCostUsd, priceFor } from "@/lib/pricing";

/**
 * Hard cap on a single provider round-trip. A stalled upstream (or a provider
 * that silently queues a routing request indefinitely) must fail the job with a
 * readable error instead of hanging the request and every UI waiting on it
 * (the step lease only releases when the fetch returns).
 *
 * Generous on purpose: a grounded generation call can legitimately run minutes
 * (web-search iterations plus up to 8k output tokens), so the cap bounds the
 * pathological case without breaking real work.
 */
export const DEFAULT_PROVIDER_TIMEOUT_MS = 600_000;

/** OpenRouter error bodies are `{"error: {message, code, ...}}` when possible. */
function providerErrorMessage(bodyText: string): string | null {
  try {
    const parsed = JSON.parse(bodyText) as { error?: { message?: unknown } };
    const message = parsed.error?.message;
    if (typeof message === "string" && message.trim()) return message.trim().slice(0, 300);
  } catch {
    // Not JSON — fall through and leave the snippet to the log only.
  }
  return null;
}

export function openRouterProvider(options: {
  apiKey: string;
  referer?: string;
  title?: string;
  fetchImpl?: typeof fetch;
  /** Override the per-request cap (see DEFAULT_PROVIDER_TIMEOUT_MS). */
  timeoutMs?: number;
}): LlmProvider {
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;

  return {
    name: "openrouter",
    async generate(request) {
      logInfo("provider", `calling ${request.model}`, {
        url: OPENROUTER_URL,
        apiKey: maskSecret(options.apiKey),
        temperature: request.temperature ?? 0.7,
        maxTokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
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
              ...(request.responseSchema ? { require_parameters: true } : {}),
            }
          : request.responseSchema
            ? { require_parameters: true }
            : undefined;

      const responseFormat = request.responseSchema
        ? {
            type: "json_schema",
            json_schema: {
              name: request.responseSchema.name,
              strict: request.responseSchema.strict ?? true,
              schema: request.responseSchema.schema,
            },
          }
        : { type: "json_object" };

      let response: Response;
      try {
        response = await doFetch(OPENROUTER_URL, {
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
            max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
            // Ask for JSON where the model supports it; the parser copes when it
            // does not, so this is an optimisation rather than a requirement.
            response_format: responseFormat,
            ...(providerRouting ? { provider: providerRouting } : {}),
            ...(request.plugins && request.plugins.length > 0 ? { plugins: request.plugins } : {}),
            ...(request.tools && request.tools.length > 0 ? { tools: request.tools } : {}),
          }),
          // No streaming and no retry loop above us: a dead upstream would
          // otherwise pin the request (and the job's step lease) forever.
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
          logError("provider", `provider request timed out after ${Math.round(timeoutMs / 1000)}s`, {
            model: request.model,
          });
          throw new LlmError(
            `The model provider did not respond within ${Math.round(timeoutMs / 1000)}s.`,
            { code: "PROVIDER_TIMEOUT", retryable: false },
          );
        }
        throw error;
      }

      const bodyText = await boundedProviderBody(response);

      if (!response.ok) {
        // 429 and 5xx are worth retrying; 4xx generally are not.
        const retryable = response.status === 429 || response.status >= 500;
        logError("provider", `HTTP ${response.status} from provider`, {
          retryable,
          bodySnippet: bodyText.slice(0, 500),
        });
        // Carry the provider's own explanation into the job error / UI: the
        // generic status alone ("returned 400") explains nothing.
        const providerMessage = providerErrorMessage(bodyText);
        throw new LlmError(
          `The model provider returned ${response.status}.${providerMessage ? ` Provider message: ${providerMessage}` : ""}`,
          {
            code: response.status === 429 ? "RATE_LIMITED" : "PROVIDER_ERROR",
            status: response.status,
            retryable,
          },
        );
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
        choices?: Array<{
          finish_reason?: string;
          message?: {
            content?: string;
            annotations?: Array<{
              type?: string;
              url_citation?: { url?: string; title?: string; content?: string };
            }>;
          };
        }>;
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

      // `url_citation` annotations are how OpenRouter surfaces the pages the
      // web plugin actually used, for every engine and model family.
      const citations: UrlCitation[] = [];
      for (const annotation of payload.choices?.[0]?.message?.annotations ?? []) {
        const citation = annotation.url_citation;
        if (annotation.type === "url_citation" && citation?.url) {
          citations.push({
            url: citation.url,
            title: citation.title,
            content: citation.content,
          });
        }
      }

      logInfo("provider", "response ok", {
        model: payload.model ?? request.model,
        promptTokens: payload.usage?.prompt_tokens ?? null,
        completionTokens: payload.usage?.completion_tokens ?? null,
        finishReason: payload.choices?.[0]?.finish_reason ?? null,
        contentChars: text.length,
        grounded: request.plugins?.length ? true : undefined,
        citations: citations.length || undefined,
      });

      return {
        text,
        model: payload.model ?? request.model,
        promptTokens: payload.usage?.prompt_tokens ?? null,
        completionTokens: payload.usage?.completion_tokens ?? null,
        finishReason: payload.choices?.[0]?.finish_reason ?? null,
        citations,
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
        finishReason: "stop",
        raw: { stub: true },
      };
    },
  };
}
