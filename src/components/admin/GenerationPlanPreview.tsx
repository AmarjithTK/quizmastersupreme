"use client";

import { AlertTriangle, CheckCircle2, Loader2, Save } from "lucide-react";
import { useEffect, useState } from "react";

type Warning = { code: string; message: string; blocking: boolean };
type Segment = {
  id: string;
  label: string;
  intent: string;
  targetCount: number;
  priority: number;
  allowedAngles: string[];
  forbiddenAngles: string[];
  entityPolicy: {
    maxPerEntity: number;
    preferredEntityClasses: string[];
    excludedEntities: string[];
  };
  sourceQueries: string[];
  sourceRequirements: string[];
};
type Blueprint = {
  version: string;
  title: string;
  interpretation: {
    objective: string;
    audience: string | null;
    inScope: string[];
    outOfScope: string[];
    assumptions: string[];
    ambiguityWarnings: Warning[];
    freshness: "stable" | "current" | "mixed";
    asOfDate: string;
  };
  segments: Segment[];
  globalPolicy: {
    maxEntityShare: number;
    maxConsecutiveSameEntity: number;
    requiredQuestionTypes: Array<{ type: string; targetShare: number }>;
    prohibitedPatterns: string[];
    language: string;
  };
};

type Detail = {
  job: { phase: string | null; requestedCount: number; batchSize: number; planRevision: number; blueprintJson: string | null; groundingMode: string | null; sources: string | null };
};

const numberField = "w-20 rounded border border-slate-300 bg-white px-2 py-1 text-sm";

export function GenerationPlanPreview({
  jobId,
  refreshKey = 0,
  onApproved,
}: {
  jobId: string;
  refreshKey?: number;
  onApproved: (orchestration: "workflow" | "manual") => void;
}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [blueprint, setBlueprint] = useState<Blueprint | null>(null);
  const [busy, setBusy] = useState<"save" | "approve" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [groundingMode, setGroundingMode] = useState<"off" | "single">("off");

  async function load() {
    const response = await fetch(`/api/admin/generation-jobs/${jobId}`);
    if (!response.ok) return;
    const body = await response.json() as Detail;
    setDetail(body);
    if (body.job.blueprintJson) setBlueprint(JSON.parse(body.job.blueprintJson) as Blueprint);
    setGroundingMode(body.job.groundingMode === "single" ? "single" : "off");
    setSaved(true);
  }

  useEffect(() => { void load(); }, [jobId, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!detail || !blueprint || detail.job.phase !== "awaiting_approval") return null;

  const total = blueprint.segments.reduce((sum, segment) => sum + segment.targetCount, 0);
  const blocking = blueprint.interpretation.ambiguityWarnings.filter((warning) => warning.blocking);
  const calls = Math.ceil(detail.job.requestedCount / Math.max(1, detail.job.batchSize));

  function changeSegment(index: number, patch: Partial<Segment>) {
    setSaved(false);
    setBlueprint((current) => current && ({
      ...current,
      segments: current.segments.map((segment, at) => at === index ? { ...segment, ...patch } : segment),
    }));
  }

  function resolveWarning(index: number, resolved: boolean) {
    setSaved(false);
    setBlueprint((current) => current && ({
      ...current,
      interpretation: {
        ...current.interpretation,
        ambiguityWarnings: current.interpretation.ambiguityWarnings.map((warning, at) =>
          at === index ? { ...warning, blocking: !resolved } : warning),
      },
    }));
  }

  async function save(): Promise<boolean> {
    if (!blueprint) return false;
    setBusy("save");
    setError(null);
    try {
      const response = await fetch(`/api/admin/generation-jobs/${jobId}/plan`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ blueprint, groundingMode }),
      });
      const body = await response.json() as { blueprint?: Blueprint; error?: { message: string } };
      if (!response.ok || !body.blueprint) throw new Error(body.error?.message ?? "Could not save the plan.");
      setBlueprint(body.blueprint);
      setSaved(true);
      await load();
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save the plan.");
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function approve() {
    setBusy("approve");
    setError(null);
    try {
      if (!saved && !(await save())) return;
      const response = await fetch(`/api/admin/generation-jobs/${jobId}/plan/approve`, { method: "POST" });
      const body = await response.json() as { error?: { message: string }; orchestration?: "workflow" | "manual" };
      if (!response.ok) throw new Error(body.error?.message ?? "Could not approve the plan.");
      onApproved(body.orchestration ?? "manual");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not approve the plan.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="flex flex-col gap-4 rounded-xl border border-violet-200 bg-violet-50/40 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-violet-700">Generation plan · revision {detail.job.planRevision}</p>
          <h2 className="mt-1 text-lg font-semibold text-slate-900">{blueprint.title}</h2>
          <p className="mt-1 max-w-4xl text-sm text-slate-600">{blueprint.interpretation.objective}</p>
        </div>
        <div className="rounded-lg bg-white px-3 py-2 text-xs text-slate-600 shadow-sm">
          {total} planned · ~{calls} model calls · as of {blueprint.interpretation.asOfDate}
        </div>
      </div>

      {blueprint.interpretation.ambiguityWarnings.length > 0 && (
        <div className="space-y-2">
          {blueprint.interpretation.ambiguityWarnings.map((warning, index) => (
            <label key={`${warning.code}-${index}`} className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-2 text-sm text-amber-900">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span className="grow"><strong>{warning.code}</strong>: {warning.message}</span>
              <input
                type="checkbox"
                checked={!warning.blocking}
                onChange={(event) => resolveWarning(index, event.target.checked)}
                aria-label={`Resolve ${warning.code}`}
              />
              <span className="text-xs">resolved</span>
            </label>
          ))}
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="min-w-full text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
            <tr><th className="p-2">Coverage segment</th><th className="p-2">Quota</th><th className="p-2">Entity cap</th><th className="p-2">Research / exclusions</th></tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {blueprint.segments.map((segment, index) => (
              <tr key={segment.id} className="align-top">
                <td className="p-2"><strong>{segment.label}</strong><p className="mt-1 max-w-xl text-xs text-slate-500">{segment.intent}</p></td>
                <td className="p-2"><input className={numberField} type="number" min={1} value={segment.targetCount} onChange={(event) => changeSegment(index, { targetCount: Math.max(1, Number(event.target.value) || 1) })} /></td>
                <td className="p-2"><input className={numberField} type="number" min={1} value={segment.entityPolicy.maxPerEntity} onChange={(event) => changeSegment(index, { entityPolicy: { ...segment.entityPolicy, maxPerEntity: Math.max(1, Number(event.target.value) || 1) } })} /></td>
                <td className="p-2 text-xs text-slate-500">
                  {segment.sourceQueries.length > 0 ? segment.sourceQueries.join(" · ") : "No web query required"}
                  {segment.forbiddenAngles.length > 0 && <p className="mt-1 text-rose-600">Avoid: {segment.forbiddenAngles.join(", ")}</p>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 bg-white p-3 text-xs text-slate-600">
        <label className="flex items-center gap-2 font-semibold text-slate-700">
          Source strategy
          <select
            className="rounded border border-slate-300 bg-white px-2 py-1 text-sm"
            value={groundingMode}
            onChange={(event) => { setSaved(false); setGroundingMode(event.target.value as "off" | "single"); }}
          >
            <option value="off">No web search</option>
            <option value="single">One bounded research stage</option>
          </select>
        </label>
        {blueprint.interpretation.freshness !== "stable" && groundingMode === "off" && !detail.job.sources && (
          <span className="text-amber-700">Current facts have no source pack. Such segments may stop as SOURCE_LIMITED; enable grounding or provide references.</span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => void save()} disabled={busy !== null} className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 disabled:opacity-50">
          {busy === "save" ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} Save revision
        </button>
        <button type="button" onClick={() => void approve()} disabled={busy !== null || blocking.length > 0} className="inline-flex items-center gap-2 rounded-lg bg-violet-700 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">
          {busy === "approve" ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />} Approve &amp; generate
        </button>
        <span className="text-xs text-slate-500">Quotas are canonically normalized to exactly {detail.job.requestedCount}. {blocking.length > 0 ? `${blocking.length} blocking warning(s) must be resolved.` : "The approved revision is frozen for every batch."}</span>
      </div>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    </section>
  );
}
