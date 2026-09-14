/**
 * Binding-backed adapters for the AI module.
 *
 * Kept apart from `pipeline.ts` on purpose: the pipeline takes a provider and a
 * storage object as arguments, so it can be tested end-to-end with stubs and
 * never touches `cloudflare:workers`. Everything that DOES need a binding lives
 * here.
 */

import { bindings } from "@/lib/cloudflare/bindings";
import { ApiError } from "@/lib/errors";
import type { RawStorage } from "./pipeline";
import { openRouterProvider, type LlmProvider } from "./provider";

/** Raw model responses, archived so a bad batch can be diagnosed later. */
export function r2RawStorage(): RawStorage {
  return {
    async put(key, value) {
      await bindings().STORAGE.put(key, value, {
        httpMetadata: { contentType: "text/plain; charset=utf-8" },
      });
    },
    async get(key) {
      const object = await bindings().STORAGE.get(key);
      return object ? await object.text() : null;
    },
  };
}

export function openRouterKeyConfigured(): boolean {
  return Boolean(bindings().OPENROUTER_API_KEY);
}

export function configuredProvider(): LlmProvider {
  const apiKey = bindings().OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new ApiError(
      "VALIDATION",
      "OPENROUTER_API_KEY is not configured. Add it to .dev.vars locally, or run `wrangler secret put OPENROUTER_API_KEY` in production.",
    );
  }
  return openRouterProvider({ apiKey, title: "Quiz Master Supreme" });
}
