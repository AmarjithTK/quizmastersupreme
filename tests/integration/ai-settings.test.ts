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
  await db().delete(schema.appSettings).where(eq(schema.appSettings.key, "ai.model"));
  await db().delete(schema.appSettings).where(eq(schema.appSettings.key, "ai.provider"));
});

afterAll(async () => {
  await db().delete(schema.appSettings).where(eq(schema.appSettings.key, "ai.model"));
  await db().delete(schema.appSettings).where(eq(schema.appSettings.key, "ai.provider"));
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
