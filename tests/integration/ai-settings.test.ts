/**
 * AI generation settings (provider + model) against real D1.
 *
 * The provider is locked to OpenRouter by design — the pipeline is
 * provider-agnostic behind `LlmProvider`, but the settings surface only
 * offers what the app supports.
 */

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { getPlatformProxy } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, setDbForTests } from "@/db/client";
import * as schema from "@/db/schema";
import {
  DEFAULT_AI_MODEL,
  getAiGenerationSettings,
  updateAiGenerationSettings,
  getProviderRouting,
  updateProviderRouting,
  AI_PROVIDERS,
} from "@/modules/settings";

const ACTOR = "user__ai_settings_test";
let proxy: { env: { DB: D1Database }; dispose: () => Promise<void> } | null = null;

beforeAll(async () => {
  proxy = await getPlatformProxy<{ DB: D1Database }>({
    configPath: "wrangler.jsonc",
    persist: { path: ".tooling/test-state" },
  });
  setDbForTests(drizzle(proxy.env.DB, { schema }));
  for (const key of ["ai.model", "ai.provider", "ai.provider_only", "ai.provider_order"]) {
    await db().delete(schema.appSettings).where(eq(schema.appSettings.key, key));
  }
});

afterAll(async () => {
  for (const key of ["ai.model", "ai.provider", "ai.provider_only", "ai.provider_order"]) {
    await db().delete(schema.appSettings).where(eq(schema.appSettings.key, key));
  }
  await proxy?.dispose();
  proxy = null;
  setDbForTests(null);
});

describe("AI generation settings", () => {
  it("defaults to the baked-in model when nothing is stored", async () => {
    const settings = await getAiGenerationSettings();
    expect(settings.model).toBe(DEFAULT_AI_MODEL);
    expect(settings.provider).toBe("openrouter");
  });

  it("persists a model choice and reads it back", async () => {
    await updateAiGenerationSettings({ model: "deepseek/deepseek-v4-flash-0731" }, ACTOR);
    const settings = await getAiGenerationSettings();
    expect(settings.model).toBe("deepseek/deepseek-v4-flash-0731");
    expect(settings.provider).toBe("openrouter");
  });

  it("rejects any provider other than OpenRouter", async () => {
    await expect(
      updateAiGenerationSettings({ provider: "anthropic" as never }, ACTOR),
    ).rejects.toThrow("Only OpenRouter");
    const settings = await getAiGenerationSettings();
    expect(AI_PROVIDERS).toContain(settings.provider);
  });

  it("rejects an empty model name", async () => {
    await expect(updateAiGenerationSettings({ model: "   " }, ACTOR)).rejects.toThrow(
      "cannot be empty",
    );
  });
});

describe("provider routing settings (only/order)", () => {
  it("round-trips only + order and rejects bad slugs", async () => {
    const saved = await updateProviderRouting(
      { only: ["together", "baidu", "deepinfra"], order: ["together", "deepinfra", "baidu"] },
      ACTOR,
    );
    expect(saved.only).toEqual(["together", "baidu", "deepinfra"]);
    expect(saved.order).toEqual(["together", "deepinfra", "baidu"]);

    await expect(
      updateProviderRouting({ only: ["not!/valid"] }, ACTOR),
    ).rejects.toThrow("Invalid provider slug");

    // A bad batch must not partially apply.
    const after = await getProviderRouting();
    expect(after.only).toEqual(["together", "baidu", "deepinfra"]);
  });

  it("deduplicates and lowercases slugs", async () => {
    const saved = await updateProviderRouting({ only: ["Together", "together"] }, ACTOR);
    expect(saved.only).toEqual(["together"]);
  });

  it("clears routing back to empty", async () => {
    await updateProviderRouting({ only: [], order: [] }, ACTOR);
    const after = await getProviderRouting();
    expect(after.only).toEqual([]);
    expect(after.order).toEqual([]);
  });
});
