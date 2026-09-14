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
type Props = {
  initial: Settings;
  initialRouting: Routing;
  providers: string[];
  modelPresets: string[];
};

const join = (slugs: string[]) => slugs.join(", ");
const split = (raw: string) =>
  raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export function AiSettingsPanel({ initial, initialRouting, providers, modelPresets }: Props) {
  const [provider, setProvider] = useState(initial.provider);
  const [model, setModel] = useState(initial.model);
  const [only, setOnly] = useState(join(initialRouting.only));
  const [order, setOrder] = useState(join(initialRouting.order));
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  useEffect(() => {
    setProvider(initial.provider);
    setModel(initial.model);
    setOnly(join(initialRouting.only));
    setOrder(join(initialRouting.order));
  }, [initial, initialRouting]);

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
          providerOnly: split(only),
          providerOrder: split(order),
        }),
      });
      const body = (await res.json()) as {
        settings?: Settings;
        error?: { message: string };
      };
      if (!res.ok) throw new Error(body.error?.message ?? "Could not save settings.");
      setNotice({ tone: "ok", text: `Saved — new jobs will use ${body.settings!.model}.` });
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
        <span className="font-normal text-slate-400">(OpenRouter provider.only / provider.order)</span>
      </h3>
      <p className="mt-1 text-xs text-slate-500">
        Pin the exact providers that may serve these models so costs are
        predictable. <code className="font-mono">only</code> = allow-list;{" "}
        <code className="font-mono">order</code> = priority. Comma-separated
        OpenRouter slugs, e.g.{" "}
        <code className="font-mono">together, deepinfra</code>. Leave blank for
        OpenRouter default routing. Nothing else is sent — no sorting, latency,
        pricing or ZDR options.
      </p>

      <label className="mt-4 block text-sm font-medium text-slate-700" htmlFor="ai-provider-only">
        only
      </label>
      <input
        id="ai-provider-only"
        value={only}
        onChange={(e) => setOnly(e.target.value)}
        placeholder="together, deepinfra"
        className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-mono focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-900/10"
      />

      <label className="mt-4 block text-sm font-medium text-slate-700" htmlFor="ai-provider-order">
        order
      </label>
      <input
        id="ai-provider-order"
        value={order}
        onChange={(e) => setOrder(e.target.value)}
        placeholder="together, baidu, deepinfra"
        className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-mono focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-900/10"
      />

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