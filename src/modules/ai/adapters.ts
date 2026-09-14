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
import { logError, logInfo, logWarn } from "@/lib/logger";
import type { RawStorage } from "./pipeline";
import { openRouterProvider, type LlmProvider } from "./provider";

/** Raw model responses, archived so a bad batch can be diagnosed later. */
export function r2RawStorage(): RawStorage {
  return {
    async put(key, value) {
      // If STORAGE is undefined here, the dev server predates the R2 binding
      // — a restart of `pnpm dev` fixes it. Make that failure loud, because
      // "generation does nothing" is the symptom.
      if (!bindings().STORAGE) {
        logError("storage", "STORAGE binding is missing — restart `pnpm dev` after adding r2_buckets to wrangler.jsonc");
        throw new ApiError("INTERNAL", "The R2 storage binding is not configured on this dev server. Restart it and try again.");
      }
      logInfo("storage", `put ${key}`, { bytes: value.length });
      await bindings().STORAGE.put(key, value, {
        httpMetadata: { contentType: "text/plain; charset=utf-8" },
      });
    },
    async get(key) {
      if (!bindings().STORAGE) {
        logError("storage", "STORAGE binding is missing — restart `pnpm dev`");
        return null;
      }
      const object = await bindings().STORAGE.get(key);
      const text = object ? await object.text() : null;
      logInfo("storage", `get ${key}`, { bytes: text?.length ?? 0, hit: object != null });
      return text;
    },
  };
}

export function openRouterKeyConfigured(): boolean {
  return Boolean(bindings().OPENROUTER_API_KEY);
}

export function configuredProvider(): LlmProvider {
  const apiKey = bindings().OPENROUTER_API_KEY;
  if (!apiKey) {
    logWarn("provider", "OPENROUTER_API_KEY is not configured");
    throw new ApiError(
      "VALIDATION",
      "OPENROUTER_API_KEY is not configured. Add it to .dev.vars locally, or run `wrangler secret put OPENROUTER_API_KEY` in production.",
    );
  }
  logInfo("provider", "using configured OpenRouter provider");
  return openRouterProvider({ apiKey, title: "Quiz Master Supreme" });
}
