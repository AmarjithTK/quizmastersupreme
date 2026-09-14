/**
 * Grounding (PIPELINE-PLAN.md §8).
 *
 * OpenRouter bills web search PER REQUEST, and the result text is charged again
 * as input tokens on whichever call carries it. So the pipeline grounds ONCE per
 * job into a shared source pool and every internal batch embeds that pool as
 * plain text. Putting `:online` on the generation calls would pay the search fee
 * on every batch and re-inject the same results each time — ~4x the generation
 * cost for zero extra information.
 *
 * Order of preference:
 *   1. the admin supplied sources        → no search at all ($0)
 *   2. a fresh cache entry for the topic → no search at all ($0)
 *   3. one research call with the web plugin
 *
 * Grounding is never a hard dependency: with `mode: "off"`, no API key, or a
 * failing provider, the job runs ungrounded and the reason is recorded.
 */

import { and, eq, lte } from "drizzle-orm";
import { db } from "@/db/client";
import { groundingCache, newId, nowMs } from "@/db/schema";
import { sha256Hex } from "@/lib/crypto";
import { logInfo, logWarn } from "@/lib/logger";
import { ApiError } from "@/lib/errors";
import { SEARCH_REQUEST_COST } from "@/lib/pricing";

export type SourceExtract = {
  title: string;
  url: string;
  excerpt: string;
};

export type SourcePool = {
  /** Facts pulled from the research call, each optionally tied to a source. */
  extracts: SourceExtract[];
  /** Every URL the search actually used (from `url_citation` annotations). */
  citations: string[];
  /** The queries the research call ran. */
  queries: string[];
  /** Free-text research summary, if the model produced one. */
  summary: string | null;
  fetchedAt: number;
};

export type GroundingEngine = "exa" | "parallel" | "perplexity";
export type GroundingMode = "off" | "single";

export type GroundingSettings = {
  mode: GroundingMode;
  engine: GroundingEngine;
  maxResults: number;
  ttlDays: number;
  includeDomains: string[];
  excludeDomains: string[];
};

export const GROUNDING_DEFAULTS: GroundingSettings = {
  // Off by default: it is a paid, network-dependent stage, and the pipeline
  // must work without it. Turn it on per job or globally when wanted.
  mode: "off",
  engine: "exa",
  maxResults: 5,
  ttlDays: 14,
  includeDomains: [],
  excludeDomains: [],
};

/**
 * Per-request search fee by engine (OpenRouter list price, Sep 2026), on top of
 * the research call's own tokens. Recorded so grounding cost is never invisible.
 */
export const GROUNDING_REQUEST_COST: Record<GroundingEngine, number> = {
  exa: SEARCH_REQUEST_COST.exa!,
  parallel: SEARCH_REQUEST_COST.parallel!,
  perplexity: SEARCH_REQUEST_COST.perplexity!,
};

export type GroundingResult = {
  pool: SourcePool | null;
  costUsd: number | null;
  cached: boolean;
  /** Set when grounding was attempted but produced nothing. Never fatal. */
  error: string | null;
  /** True when the stage did not run at all (off, or user sources supplied). */
  skipped: boolean;
};

/** The `web` plugin payload for OpenRouter. */
export function webPlugin(settings: GroundingSettings): Array<Record<string, unknown>> {
  const plugin: Record<string, unknown> = {
    id: "web",
    engine: settings.engine,
    max_results: settings.maxResults,
  };
  if (settings.includeDomains.length > 0) plugin.include_domains = settings.includeDomains;
  if (settings.excludeDomains.length > 0) plugin.exclude_domains = settings.excludeDomains;
  return [plugin];
}

/** Cache key: the same topic + engine + shape must hit the same entry. */
export async function groundingCacheKey(
  topic: string,
  settings: GroundingSettings,
): Promise<string> {
  const normalised = topic.trim().toLowerCase().replace(/\s+/g, " ");
  return sha256Hex(
    [
      normalised,
      settings.engine,
      String(settings.maxResults),
      settings.includeDomains.join(","),
      settings.excludeDomains.join(","),
    ].join("|"),
  );
}

/** What the research call is asked to produce. */
export function buildResearchPrompt(topic: string, brief: string): { system: string; user: string } {
  return {
    system: [
      "You are a research assistant building a FACT SHEET for a quiz writer.",
      "Search the web and return only verifiable, checkable facts about the topic.",
      "Prefer stable, widely-documented facts over breaking news.",
      "Never invent a fact or a source. If something is uncertain, omit it.",
      'Reply with JSON only: {"summary": string, "facts": [{"subject": string, "fact": string, "source_url": string}]}',
      "Aim for 15–30 facts.",
    ].join("\n"),
    user: [
      `Topic: ${topic}`,
      brief.trim() ? `Focus: ${brief.trim()}` : "",
      "",
      "Return the JSON fact sheet now.",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

type ParsedResearch = {
  summary: string | null;
  facts: Array<{ subject: string; fact: string; sourceUrl: string | null }>;
};

/** Tolerant parse: the fact sheet is JSON, but prose wrappers happen. */
export function parseResearch(text: string): ParsedResearch {
  const cleaned = text
    .replace(/^\s*```(?:json)?/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  const candidate = start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    // Not JSON at all: keep the prose as the summary rather than losing it.
    return { summary: cleaned.slice(0, 4_000) || null, facts: [] };
  }

  const body = parsed as {
    summary?: unknown;
    facts?: Array<{ subject?: unknown; fact?: unknown; source_url?: unknown; sourceUrl?: unknown }>;
  };

  const facts: ParsedResearch["facts"] = [];
  for (const row of Array.isArray(body.facts) ? body.facts : []) {
    const fact = typeof row?.fact === "string" ? row.fact.trim() : "";
    if (!fact) continue;
    const url = row.source_url ?? row.sourceUrl;
    facts.push({
      subject: typeof row.subject === "string" ? row.subject.trim() : "",
      fact,
      sourceUrl: typeof url === "string" && url.startsWith("http") ? url : null,
    });
  }

  return {
    summary: typeof body.summary === "string" ? body.summary.trim() || null : null,
    facts,
  };
}

export type GroundingDeps = {
  /**
   * The research call's provider. Injected, like generation's, so the tests can
   * drive grounding with a stub and no network.
   */
  provider: {
    generate(request: {
      model: string;
      system: string;
      user: string;
      temperature?: number;
      maxTokens?: number;
      plugins?: Array<Record<string, unknown>>;
    }): Promise<{
      text: string;
      model: string;
      promptTokens: number | null;
      completionTokens: number | null;
      citations?: Array<{ url: string; title?: string; content?: string }>;
      raw: unknown;
    }>;
    readonly name: string;
  };
  model: string;
  /** Token cost estimator, injected so pricing stays in one place. */
  estimateCostUsd: (
    model: string,
    promptTokens: number | null,
    completionTokens: number | null,
  ) => number | null;
};

/**
 * Build (or reuse) the shared source pool for a job.
 *
 * Never throws for provider/network reasons: grounding is an enhancement, and a
 * job must still run when it fails.
 */
export async function buildSourcePool(
  input: {
    topic: string;
    brief: string;
    /** Admin-supplied sources win outright — no search, no cost. */
    userSources?: string | null;
    settings: GroundingSettings;
  },
  deps: GroundingDeps,
): Promise<GroundingResult> {
  const { settings } = input;

  if (settings.mode === "off") {
    return { pool: null, costUsd: null, cached: false, error: null, skipped: true };
  }
  if (input.userSources?.trim()) {
    logInfo("grounding", "skipped: admin supplied sources", { topic: input.topic });
    return { pool: null, costUsd: 0, cached: false, error: null, skipped: true };
  }

  const key = await groundingCacheKey(input.topic, settings);
  const now = nowMs();

  // ── cache ────────────────────────────────────────────────────────────────
  const cached = (
    await db().select().from(groundingCache).where(eq(groundingCache.key, key)).limit(1)
  )[0];
  if (cached && cached.expiresAt > now) {
    logInfo("grounding", "cache hit", { topic: input.topic, engine: settings.engine });
    return {
      pool: JSON.parse(cached.payload) as SourcePool,
      costUsd: 0,
      cached: true,
      error: null,
      skipped: false,
    };
  }

  // ── the one research call ────────────────────────────────────────────────
  const prompt = buildResearchPrompt(input.topic, input.brief);
  let response;
  try {
    response = await deps.provider.generate({
      model: deps.model,
      system: prompt.system,
      user: prompt.user,
      temperature: 0.2,
      maxTokens: 4_000,
      plugins: webPlugin(settings),
    });
  } catch (error) {
    const message = error instanceof ApiError ? error.message : (error as Error)?.message;
    logWarn("grounding", "research call failed", { topic: input.topic, message });
    return {
      pool: null,
      costUsd: null,
      cached: false,
      error: message || "The grounding search failed.",
      skipped: false,
    };
  }

  const parsed = parseResearch(response.text);
  const citations = (response.citations ?? []).map((citation) => citation.url);
  const pool: SourcePool = {
    extracts: parsed.facts.map((fact) => ({
      title: fact.subject || input.topic,
      url: fact.sourceUrl ?? "",
      excerpt: fact.fact,
    })),
    citations: [...new Set(citations)],
    queries: [input.topic],
    summary: parsed.summary,
    fetchedAt: now,
  };

  const tokenCost = deps.estimateCostUsd(
    response.model,
    response.promptTokens,
    response.completionTokens,
  );
  const costUsd =
    Math.round(((tokenCost ?? 0) + GROUNDING_REQUEST_COST[settings.engine]) * 1_000_000) / 1_000_000;

  if (pool.extracts.length === 0 && pool.citations.length === 0) {
    return {
      pool: null,
      costUsd,
      cached: false,
      error: "The search returned no usable facts.",
      skipped: false,
    };
  }

  // ── store for the next job on this topic ─────────────────────────────────
  const expiresAt = now + settings.ttlDays * 24 * 60 * 60 * 1000;
  try {
    await db()
      .delete(groundingCache)
      .where(eq(groundingCache.key, key));
    await db().insert(groundingCache).values({
      key,
      topic: input.topic,
      engine: settings.engine,
      payload: JSON.stringify(pool),
      queries: JSON.stringify(pool.queries),
      costUsd,
      fetchedAt: now,
      expiresAt,
    });
  } catch (error) {
    // A cache write failure must not fail the job.
    logWarn("grounding", "could not cache the source pool", { message: (error as Error)?.message });
  }

  logInfo("grounding", "pool built", {
    topic: input.topic,
    facts: pool.extracts.length,
    citations: pool.citations.length,
    costUsd,
  });

  return { pool, costUsd, cached: false, error: null, skipped: false };
}

/** Drop expired cache rows. Cheap enough to run opportunistically. */
export async function pruneGroundingCache(): Promise<number> {
  const result = await db()
    .delete(groundingCache)
    .where(lte(groundingCache.expiresAt, nowMs()));
  return Number((result as { meta?: { changes?: number } })?.meta?.changes ?? 0);
}

/** The prompt block a grounded pool contributes. Budgeted by the caller. */
export function renderSourcePool(pool: SourcePool, maxTokens = 1_500): string {
  const lines: string[] = ["", "WEB RESEARCH (authoritative context for this topic):"];
  let used = 0;

  if (pool.summary) {
    const block = pool.summary.slice(0, 1_200);
    lines.push("", block, "");
    used += Math.ceil(block.length / 4);
  }

  for (const extract of pool.extracts) {
    const line = `- ${extract.title ? `${extract.title}: ` : ""}${extract.excerpt}`;
    const cost = Math.ceil(line.length / 4);
    if (used + cost > maxTokens) break;
    lines.push(line);
    used += cost;
  }

  if (pool.citations.length > 0) {
    lines.push("", `Sources: ${pool.citations.slice(0, 10).join(", ")}`);
  }

  return lines.join("\n");
}

/** Row id helper kept here so the module owns its own identifiers. */
export const newGroundingId = newId;

/** Re-export for callers that only need the table. */
export { groundingCache, and };
