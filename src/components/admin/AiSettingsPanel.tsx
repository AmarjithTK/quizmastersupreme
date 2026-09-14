"use client";

/**
 * AI generation settings (provider + model).
 *
 * The provider dropdown only ever contains OpenRouter — the pipeline is
 * provider-agnostic behind `LlmProvider`, but this screen deliberately offers
 * one option. The model is a preset list with free-text fallback; the stored
 * value becomes the default for new generation jobs.
 */

import { useEffect, useState } from "react";
import { Save } from "lucide-react";
import { cn } from "@/lib/utils";

type Settings = { provider: string; model: string };
type Routing = { only: string[]; order: string[] };
type Generation = {
  batchSize: number;
  maxRequested: number;
  minRefill: number;
  maxCalls: number;
  countMode: "at_least_trim" | "exact";
  groundingMode: "off" | "single";
  groundingEngine: "exa" | "parallel" | "perplexity";
  groundingMaxResults: number;
  groundingTtlDays: number;
  groundingIncludeDomains: string;
  groundingExcludeDomains: string;
};
type Limits = Record<"batchSize" | "maxRequested" | "minRefill" | "maxCalls", { min: number; max: number }>;
type Props = {
  initial: Settings;
  initialRouting: Routing;
  initialGeneration: Generation;
  generationLimits: Limits;
  providers: string[];
  modelPresets: string[];
};

const join = (slugs: string[]) => slugs.join(", ");
const split = (raw: string) => raw.split(",").map((s) => s.trim()).filter(Boolean);

/** `only` and `order` are mutually exclusive — one mode at a time. */
type RoutingMode = "none" | "only" | "order";

function modeOf(routing: Routing): RoutingMode {
  if (routing.only.length > 0) return "only";
  if (routing.order.length > 0) return "order";
  return "none";
}

export function AiSettingsPanel({
  initial,
  initialRouting,
  initialGeneration,
  generationLimits,
  providers,
  modelPresets,
}: Props) {
  const [provider, setProvider] = useState(initial.provider);
  const [model, setModel] = useState(initial.model);
  // Kept as strings so the fields can be edited freely; parsed on save.
  const [batchSize, setBatchSize] = useState(String(initialGeneration.batchSize));
  const [maxRequested, setMaxRequested] = useState(String(initialGeneration.maxRequested));
  const [minRefill, setMinRefill] = useState(String(initialGeneration.minRefill));
  const [maxCalls, setMaxCalls] = useState(String(initialGeneration.maxCalls));
  const [countMode, setCountMode] = useState(initialGeneration.countMode);
  const [groundingMode, setGroundingMode] = useState(initialGeneration.groundingMode);
  const [groundingEngine, setGroundingEngine] = useState(initialGeneration.groundingEngine);
  const [groundingMaxResults, setGroundingMaxResults] = useState(
    String(initialGeneration.groundingMaxResults),
  );
  const [groundingTtlDays, setGroundingTtlDays] = useState(
    String(initialGeneration.groundingTtlDays),
  );
  const [groundingIncludeDomains, setGroundingIncludeDomains] = useState(
    initialGeneration.groundingIncludeDomains,
  );
  const [groundingExcludeDomains, setGroundingExcludeDomains] = useState(
    initialGeneration.groundingExcludeDomains,
  );
  const [mode, setMode] = useState<RoutingMode>(modeOf(initialRouting));
  const [slugs, setSlugs] = useState(
    initialRouting.only.length > 0
      ? join(initialRouting.only)
      : join(initialRouting.order),
  );
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  useEffect(() => {
    setProvider(initial.provider);
    setModel(initial.model);
    setMode(modeOf(initialRouting));
    setSlugs(
      initialRouting.only.length > 0
        ? join(initialRouting.only)
        : join(initialRouting.order),
    );
    setBatchSize(String(initialGeneration.batchSize));
    setMaxRequested(String(initialGeneration.maxRequested));
    setMinRefill(String(initialGeneration.minRefill));
    setMaxCalls(String(initialGeneration.maxCalls));
    setCountMode(initialGeneration.countMode);
    setGroundingMode(initialGeneration.groundingMode);
    setGroundingEngine(initialGeneration.groundingEngine);
    setGroundingMaxResults(String(initialGeneration.groundingMaxResults));
    setGroundingTtlDays(String(initialGeneration.groundingTtlDays));
    setGroundingIncludeDomains(initialGeneration.groundingIncludeDomains);
    setGroundingExcludeDomains(initialGeneration.groundingExcludeDomains);
  }, [initial, initialRouting, initialGeneration]);

  async function save() {
    setSaving(true);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/settings/ai", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider,
          model: model.trim(),
          providerOnly: mode === "only" ? split(slugs) : [],
          providerOrder: mode === "order" ? split(slugs) : [],
          generation: {
            batchSize: Number(batchSize),
            maxRequested: Number(maxRequested),
            minRefill: Number(minRefill),
            maxCalls: Number(maxCalls),
            countMode,
            groundingMode,
            groundingEngine,
            groundingMaxResults: Number(groundingMaxResults),
            groundingTtlDays: Number(groundingTtlDays),
            groundingIncludeDomains,
            groundingExcludeDomains,
          },
        }),
      });
      const body = (await res.json()) as {
        settings?: Settings;
        error?: { message: string };
      };
      if (!res.ok) throw new Error(body.error?.message ?? "Could not save settings.");
      setNotice({
        tone: "ok",
        text: `Saved — new jobs use ${body.settings!.model} in batches of ${batchSize}.`,
      });
    } catch (e) {
      setNotice({ tone: "err", text: e instanceof Error ? e.message : "Could not save settings." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="max-w-xl rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
      <h2 className="text-base font-semibold text-slate-900">AI generation</h2>
      <p className="mt-1 text-sm text-slate-500">
        The model used as the default when a new generation job is created. Individual jobs can
        still override it on the Generate screen.
      </p>

      <label className="mt-5 block text-sm font-medium text-slate-700" htmlFor="ai-provider">
        Provider
      </label>
      <select
        id="ai-provider"
        value={provider}
        onChange={(e) => setProvider(e.target.value)}
        className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-900/10"
      >
        {providers.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>
      <p className="mt-1 text-[11px] text-slate-400">
        Only OpenRouter is supported — add another provider if that changes.
      </p>

      <label className="mt-4 block text-sm font-medium text-slate-700" htmlFor="ai-model">
        Model
      </label>
      <input
        id="ai-model"
        list="ai-model-presets"
        value={model}
        onChange={(e) => setModel(e.target.value)}
        className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-mono focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-900/10"
      />
      <datalist id="ai-model-presets">
        {modelPresets.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>

      <hr className="mt-6 border-slate-200" />

      <h3 className="mt-5 text-sm font-semibold text-slate-800">
        Provider routing{" "}
        <span className="font-normal text-slate-400">(provider.only · provider.order)</span>
      </h3>
      <p className="mt-1 text-xs text-slate-500">
        Pin the exact providers that may serve these models so costs are
        predictable. <code className="font-mono">only</code> = allow-list;{" "}
        <code className="font-mono">order</code> = priority.{" "}
        <span className="font-semibold text-slate-700">Pick one — the two cannot be set together.</span>{" "}
        Nothing else is sent: no sorting, latency, pricing or ZDR options.
      </p>

      <fieldset className="mt-4">
        <legend className="sr-only">Routing mode</legend>
        <div className="flex flex-wrap gap-2">
          {(
            [
              ["none", "Default routing"],
              ["only", "only — allow-list"],
              ["order", "order — priority"],
            ] as Array<[RoutingMode, string]>
          ).map(([value, label]) => (
            <label
              key={value}
              className={[
                "cursor-pointer rounded-lg border px-3 py-1.5 text-sm font-medium",
                mode === value
                  ? "border-slate-900 bg-slate-900 text-white"
                  : "border-slate-300 bg-white text-slate-600 hover:bg-slate-50",
              ].join(" ")}
            >
              <input
                type="radio"
                name="routing-mode"
                value={value}
                checked={mode === value}
                onChange={() => setMode(value)}
                className="sr-only"
              />
              {label}
            </label>
          ))}
        </div>
      </fieldset>

      {mode !== "none" && (
        <label className="mt-4 block text-sm font-medium text-slate-700" htmlFor="ai-routing-slugs">
          {mode === "only" ? "Allowed providers" : "Preferred order"} (comma-separated OpenRouter slugs)
        </label>
      )}
      {mode === "none" && (
        <p className="mt-4 text-xs text-slate-400">
          No routing — OpenRouter picks the provider. Set one mode above to pin cost.
        </p>
      )}
      {mode !== "none" && (
        <input
          id="ai-routing-slugs"
          value={slugs}
          onChange={(e) => setSlugs(e.target.value)}
          placeholder={mode === "only" ? "together, deepinfra" : "together, baidu, deepinfra"}
          className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-mono focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-900/10"
        />
      )}

      <hr className="mt-6 border-slate-200" />

      <h3 className="mt-5 text-sm font-semibold text-slate-800">Generation pipeline</h3>
      <p className="mt-1 text-xs text-slate-500">
        One job is generated in small internal batches, filtered after every batch and refilled
        until the target is met. The batch size is also overridable per job on the Generate screen.
      </p>

      <div className="mt-4 grid grid-cols-2 gap-3">
        {(
          [
            ["batchSize", "Batch size (per call)", batchSize, setBatchSize, "25"],
            ["maxRequested", "Max target per job", maxRequested, setMaxRequested, "300"],
            ["minRefill", "Min refill ask", minRefill, setMinRefill, "5"],
            ["maxCalls", "Max calls per job", maxCalls, setMaxCalls, "20"],
          ] as Array<[keyof Limits, string, string, (v: string) => void, string]>
        ).map(([key, label, value, setValue, placeholder]) => (
          <label key={key} className="flex flex-col gap-1 text-xs font-medium text-slate-600">
            {label}
            <input
              type="number"
              min={generationLimits[key].min}
              max={generationLimits[key].max}
              value={value}
              placeholder={placeholder}
              onChange={(e) => setValue(e.target.value)}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-900/10"
            />
            <span className="text-[10px] font-normal text-slate-400">
              {generationLimits[key].min}–{generationLimits[key].max}
            </span>
          </label>
        ))}
      </div>

      <fieldset className="mt-4">
        <legend className="text-xs font-medium text-slate-600">When the target is reached</legend>
        <div className="mt-1 flex flex-wrap gap-2">
          {(
            [
              ["at_least_trim", "Overshoot, then add exactly the target"],
              ["exact", "Ask only for the remainder"],
            ] as Array<["at_least_trim" | "exact", string]>
          ).map(([value, label]) => (
            <label
              key={value}
              className={[
                "cursor-pointer rounded-lg border px-3 py-1.5 text-xs font-medium",
                countMode === value
                  ? "border-slate-900 bg-slate-900 text-white"
                  : "border-slate-300 bg-white text-slate-600 hover:bg-slate-50",
              ].join(" ")}
            >
              <input
                type="radio"
                name="count-mode"
                value={value}
                checked={countMode === value}
                onChange={() => setCountMode(value)}
                className="sr-only"
              />
              {label}
            </label>
          ))}
        </div>
      </fieldset>

      <hr className="mt-6 border-slate-200" />

      <h3 className="mt-5 text-sm font-semibold text-slate-800">Web grounding</h3>
      <p className="mt-1 text-xs text-slate-500">
        One OpenRouter search per job builds a shared fact sheet that every batch reuses. Search
        is billed <strong>per request</strong> (~$0.007 on Exa), so this runs once and is cached —
        it is never enabled on the per-batch generation calls. Multi-search is intentionally not
        offered: it would make the cost of a job unpredictable.
      </p>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          Mode
          <select
            value={groundingMode}
            onChange={(e) => setGroundingMode(e.target.value as Generation["groundingMode"])}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-900/10"
          >
            <option value="off">off — no search, no cost</option>
            <option value="single">single — one research call per job</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          Engine
          <select
            value={groundingEngine}
            onChange={(e) => setGroundingEngine(e.target.value as Generation["groundingEngine"])}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-900/10"
          >
            <option value="exa">exa — $0.007/request (best quality)</option>
            <option value="parallel">parallel — $0.005/request</option>
            <option value="perplexity">perplexity — $0.005/request</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          Results per search (1–10)
          <input
            type="number"
            min={1}
            max={10}
            value={groundingMaxResults}
            onChange={(e) => setGroundingMaxResults(e.target.value)}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-900/10"
          />
          <span className="text-[10px] font-normal text-slate-400">
            each result is ~2–4k characters of billed input
          </span>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          Cache TTL (days, 0–90)
          <input
            type="number"
            min={0}
            max={90}
            value={groundingTtlDays}
            onChange={(e) => setGroundingTtlDays(e.target.value)}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-900/10"
          />
          <span className="text-[10px] font-normal text-slate-400">
            repeat topics then cost $0 in search
          </span>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          Include domains (comma-separated, optional)
          <input
            value={groundingIncludeDomains}
            onChange={(e) => setGroundingIncludeDomains(e.target.value)}
            placeholder="example.com, *.gov.in"
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-mono focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-900/10"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          Exclude domains (comma-separated, optional)
          <input
            value={groundingExcludeDomains}
            onChange={(e) => setGroundingExcludeDomains(e.target.value)}
            placeholder="reddit.com"
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-mono focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-900/10"
          />
        </label>
      </div>

      <div className="mt-5 flex items-center gap-3">
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || !model.trim()}
          className={cn(
            "inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white",
            "hover:bg-slate-700 disabled:opacity-50",
          )}
        >
          <Save className="size-4" />
          {saving ? "Saving…" : "Save"}
        </button>
        {notice && (
          <span className={cn("text-sm", notice.tone === "ok" ? "text-emerald-600" : "text-red-600")}>
            {notice.text}
          </span>
        )}
      </div>
    </section>
  );
}