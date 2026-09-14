/**
 * OpenRouter client (M10), tested with an injected `fetch`.
 *
 * This is better than a live call: it asserts the exact request we put on the
 * wire (endpoint, auth header, message roles, JSON mode) and how every failure
 * mode maps, deterministically and without a key or a network.
 */

import { describe, expect, it, vi } from "vitest";
import { estimateCostUsd, LlmError, openRouterProvider } from "@/modules/ai";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const okBody = {
  model: "anthropic/claude-sonnet-4.5",
  choices: [{ message: { content: '{"questions":[]}' } }],
  usage: { prompt_tokens: 1234, completion_tokens: 567 },
};

describe("openRouterProvider", () => {
  it("sends the request OpenRouter expects", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(okBody));
    const provider = openRouterProvider({ apiKey: "test-key", title: "Quiz Master Supreme", fetchImpl });

    await provider.generate({
      model: "anthropic/claude-sonnet-4.5",
      system: "SYSTEM PROMPT",
      user: "USER PROMPT",
      temperature: 0.4,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];

    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(init.method).toBe("POST");

    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer test-key");
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["X-Title"]).toBe("Quiz Master Supreme");

    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.model).toBe("anthropic/claude-sonnet-4.5");
    expect(body.temperature).toBe(0.4);
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages).toEqual([
      { role: "system", content: "SYSTEM PROMPT" },
      { role: "user", content: "USER PROMPT" },
    ]);
  });

  it("returns the text, model and token usage", async () => {
    const provider = openRouterProvider({
      apiKey: "k",
      fetchImpl: async () => jsonResponse(okBody),
    });

    const response = await provider.generate({ model: "m", system: "s", user: "u" });

    expect(response.text).toBe('{"questions":[]}');
    expect(response.model).toBe("anthropic/claude-sonnet-4.5");
    expect(response.promptTokens).toBe(1234);
    expect(response.completionTokens).toBe(567);
    expect(response.raw).toEqual(okBody);
  });

  it("marks 429 and 5xx as retryable and 4xx as not", async () => {
    const rateLimited = openRouterProvider({
      apiKey: "k",
      fetchImpl: async () => new Response("slow down", { status: 429 }),
    });
    await expect(rateLimited.generate({ model: "m", system: "s", user: "u" })).rejects.toMatchObject({
      code: "RATE_LIMITED",
      retryable: true,
    });

    const serverError = openRouterProvider({
      apiKey: "k",
      fetchImpl: async () => new Response("boom", { status: 502 }),
    });
    await expect(serverError.generate({ model: "m", system: "s", user: "u" })).rejects.toMatchObject({
      retryable: true,
    });

    const unauthorised = openRouterProvider({
      apiKey: "bad",
      fetchImpl: async () => new Response("no", { status: 401 }),
    });
    const error = await unauthorised.generate({ model: "m", system: "s", user: "u" }).catch((e) => e);
    expect(error).toBeInstanceOf(LlmError);
    expect((error as LlmError).retryable).toBe(false);
    expect((error as LlmError).status).toBe(401);
  });

  it("rejects a non-JSON provider response", async () => {
    const provider = openRouterProvider({
      apiKey: "k",
      fetchImpl: async () => new Response("<html>gateway</html>", { status: 200 }),
    });
    await expect(provider.generate({ model: "m", system: "s", user: "u" })).rejects.toMatchObject({
      code: "BAD_PROVIDER_RESPONSE",
    });
  });

  it("rejects an empty completion", async () => {
    const provider = openRouterProvider({
      apiKey: "k",
      fetchImpl: async () => jsonResponse({ choices: [{ message: { content: "   " } }] }),
    });
    await expect(provider.generate({ model: "m", system: "s", user: "u" })).rejects.toMatchObject({
      code: "EMPTY_RESPONSE",
    });
  });

  it("never leaks the API key into the thrown error message", async () => {
    const provider = openRouterProvider({
      apiKey: "sk-secret-value",
      fetchImpl: async () => new Response("denied", { status: 401 }),
    });
    const error = await provider.generate({ model: "m", system: "s", user: "u" }).catch((e) => e);
    expect((error as Error).message).not.toContain("sk-secret-value");
  });
});

describe("estimateCostUsd", () => {
  it("returns null when usage is unknown", () => {
    expect(estimateCostUsd("m", null, null)).toBeNull();
  });

  it("scales with tokens", () => {
    const small = estimateCostUsd("m", 1000, 1000)!;
    const large = estimateCostUsd("m", 10_000, 10_000)!;
    expect(large).toBeGreaterThan(small);
    expect(small).toBeGreaterThan(0);
  });
});
