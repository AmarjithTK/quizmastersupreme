"use client";

/**
 * Generation panel (M10).
 *
 * Creating a job and RUNNING it are separate actions on purpose. Creation just
 * writes a row; the run loop calls `/step` until the job reports `done`, so no
 * single request owns the whole job and closing the tab mid-run loses nothing —
 * the job resumes from D1 + R2 (§2.8).
 *
 * Nothing generated here is published. Every candidate lands in the review
 * queue, and a human promotes it (§2.2).
 */

import { AlertCircle, Flag, Loader2, Play, Sparkles } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { BatchReview } from "@/components/admin/BatchReview";
import { estimateJobCostUsd } from "@/lib/pricing";
import { LocalTime } from "@/components/ui/LocalTime";

type Job = {
  id: string;
  topic: string;
  model: string;
  status: string;
  requestedCount: number;
  acceptedCount: number;
  producedCount: number;
  validCount: number;
  duplicateCount: number;
  batchSize: number;
  maxCalls: number;
  backfillRound: number;
  groundingCostUsd: number | null;
  groundingCached: number;
  costUsd: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  providerOnly: string | null;
  providerOrder: string | null;
  createdAt: number;
};

type Progress = {
  jobId: string;
  status: string;
  /** The target: clean questions the job is driving for. */
  requestedCount: number;
  /** Clean questions accepted so far. */
  acceptedCount: number;
  producedCount: number;
  validCount: number;
  duplicateCount: number;
  /** Calls made so far. */
  round: number;
  /** Planned calls at the current batch size. */
  totalPlannedCalls: number;
  batchSize: number;
  /** One-off web grounding: what it cost, and whether it came from cache. */
  groundingCostUsd: number | null;
  groundingCached: boolean;
  done: boolean;
  error: string | null;
};

const field =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-900/10";

const STATUS_TONE: Record<string, string> = {
  queued: "bg-slate-100 text-slate-600",
  running: "bg-sky-50 text-sky-700",
  succeeded: "bg-emerald-50 text-emerald-700",
  partial: "bg-amber-50 text-amber-700",
  failed: "bg-red-50 text-red-700",
  cancelled: "bg-slate-100 text-slate-400",
};

export function GenerationPanel({
  initialJobs,
  configured,
  defaultModel,
  defaultBatchSize = 25,
  maxRequested = 300,
  defaultGroundingMode = "off",
  categories,
  sets,
}: {
  initialJobs: Job[];
  configured: boolean;
  defaultModel: string;
  /** Global `generation.batch_size`; overridable per job. */
  defaultBatchSize?: number;
  /** Global `generation.max_requested` ceiling. */
  maxRequested?: number;
  /** Global `generation.grounding_mode`; overridable per job. */
  defaultGroundingMode?: "off" | "single" | "agentic";
  categories: Array<{ id: string; title: string }>;
  sets: Array<{ id: string; title: string; status: string; categoryTitle?: string }>;
}) {
  const [jobs, setJobs] = useState<Job[]>(initialJobs);
  const [topic, setTopic] = useState("");
  const [brief, setBrief] = useState("");
  const [target, setTarget] = useState("");
  const [sources, setSources] = useState("");
  const [count, setCount] = useState("25");
  const [batchSize, setBatchSize] = useState(String(defaultBatchSize));
  const [groundingMode, setGroundingMode] = useState(defaultGroundingMode);
  const [difficulty, setDifficulty] = useState("medium");
  const [model, setModel] = useState(defaultModel);
  const [categoryId, setCategoryId] = useState("");

  /** The job whose generated set is open in the batch view below. */
  const [batchJobId, setBatchJobId] = useState<string | null>(null);
  /**
   * Bumped after every generation round. The batch view reloads on change, so
   * the questions appear as they arrive instead of only when the panel is
   * remounted — no refresh, no "Review batch" click.
   */
  const [batchRefresh, setBatchRefresh] = useState(0);

  const [runningJobId, setRunningJobId] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refetch() {
    const res = await fetch("/api/admin/generation-jobs");
    if (!res.ok) return;
    const body = (await res.json()) as { jobs: Job[] };
    setJobs(body.jobs);
  }

  /** Bring the generated-set review into view (it opens on its own). */
  function scrollToBatch() {
    // After paint, so the freshly rendered review exists to scroll to.
    requestAnimationFrame(() => {
      document.getElementById("batch-review")?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    });
  }

  async function createAndRun() {
    setError(null);
    setProgress(null);

    if (!topic.trim() || !brief.trim()) {
      setError("A topic and a brief are both required.");
      return;
    }

    try {
      const createRes = await fetch("/api/admin/generation-jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          topic,
          brief,
          target: target.trim() || null,
          sources: sources.trim() || null,
          requestedCount: Number(count) || 25,
          batchSize: Number(batchSize) || defaultBatchSize,
          groundingMode,
          difficulty,
          model,
          targetCategoryId: categoryId || null,
        }),
      });
      const created = (await createRes.json()) as { job?: Job; error?: { message: string } };
      if (!createRes.ok || !created.job) {
        throw new Error(created.error?.message ?? "Could not create the job.");
      }

      const jobId = created.job.id;
      setRunningJobId(jobId);
      setBatchJobId(jobId);
      await refetch();
      // Open the review immediately, then keep it in view as it fills up.
      scrollToBatch();

      // Advance until the job says it is done. Each call is ONE internal batch,
      // so a 300-question job at 25/call needs up to ~12-16 calls; the job's own
      // max_calls terminates the loop, this bound is just a browser-side backstop.
      for (let step = 0; step < 60; step++) {
        const res = await fetch(`/api/admin/generation-jobs/${jobId}/step`, { method: "POST" });
        const body = (await res.json()) as { progress?: Progress; error?: { message: string } };
        if (!res.ok || !body.progress) {
          throw new Error(body.error?.message ?? "The generation step failed.");
        }
        setProgress(body.progress);
        await refetch();
        // Hand the fresh questions to the review screen right away.
        setBatchRefresh((n) => n + 1);
        if (body.progress.done) break;
      }

      setTopic("");
      setBrief("");
      setTarget("");
      setSources("");
      scrollToBatch();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setRunningJobId(null);
    }
  }

  const running = runningJobId !== null;

  return (
    <div className="flex flex-col gap-6">
      {!configured && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>
            <strong className="font-semibold">OPENROUTER_API_KEY is not set.</strong> Add it to{" "}
            <code className="rounded bg-amber-100 px-1">.dev.vars</code> and restart the dev server,
            or run <code className="rounded bg-amber-100 px-1">wrangler secret put OPENROUTER_API_KEY</code>{" "}
            for production. Everything else in the app works without it.
          </span>
        </div>
      )}

      {error && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </div>
      )}

      <section className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
          <Sparkles className="size-4" />
          Generate questions
        </h2>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
            Topic *
            <input
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              className={field}
              placeholder="Operating Systems"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
            Target subject (optional)
            <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className={field}>
              <option value="">None</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          Target (optional)
          <input
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className={field}
            placeholder="Class 10 students / Kerala PSC exam / UPSC prelims…"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          Sources (optional)
          <textarea
            value={sources}
            onChange={(e) => setSources(e.target.value)}
            rows={2}
            className={field}
            placeholder="Only base questions on these: e.g. https://kerala.gov.in/cyber-security, Cyberdome 2015 report…"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          Brief *{" "}
          <span className="font-normal text-slate-400">(specific instructions)</span>
          <textarea
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            rows={3}
            className={field}
            placeholder="Focus on Kerala PSC style. Avoid trivia about version numbers. Include one question on Semaphore vs Mutex."
          />
        </label>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
            Target questions
            <input
              type="number"
              min={1}
              max={maxRequested}
              value={count}
              onChange={(e) => setCount(e.target.value)}
              className={field}
            />
            <span className="text-[10px] font-normal text-slate-400">
              ≈ ${estimateJobCostUsd(Number(count) || 25, Number(batchSize) || 25, model).toFixed(4)}{" "}
              · {Math.max(1, Math.ceil((Number(count) || 25) / (Number(batchSize) || 25)))} batches
            </span>
            <span className="flex flex-wrap gap-1 pt-0.5">
              {[25, 50, 100, 200, 300]
                .filter((n) => n <= maxRequested)
                .map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setCount(String(n))}
                    className={cn(
                      "rounded border px-1.5 py-0.5 text-[10px] font-semibold",
                      count === String(n)
                        ? "border-slate-900 bg-slate-900 text-white"
                        : "border-slate-300 bg-white text-slate-600 hover:bg-slate-100",
                    )}
                  >
                    {n}
                  </button>
                ))}
            </span>
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
            Batch size (per call)
            <input
              type="number"
              min={5}
              max={50}
              value={batchSize}
              onChange={(e) => setBatchSize(e.target.value)}
              className={field}
            />
            <span className="text-[10px] font-normal text-slate-400">
              Small batches keep quality high · 5–50
            </span>
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
            Web grounding
            <select
              value={groundingMode}
              onChange={(e) =>
                setGroundingMode(e.target.value as "off" | "single" | "agentic")
              }
              className={field}
            >
              <option value="off">off — no search</option>
              <option value="single">one search per job</option>
              <option value="agentic">agentic — multi-search</option>
            </select>
            <span className="text-[10px] font-normal text-slate-400">
              one research call, cached for later jobs
            </span>
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
            Difficulty
            <select value={difficulty} onChange={(e) => setDifficulty(e.target.value)} className={field}>
              {["easy", "medium", "hard", "expert"].map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
            Model
            <input value={model} onChange={(e) => setModel(e.target.value)} className={field} />
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void createAndRun()}
            disabled={running || !configured}
            className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
          >
            {running ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
            {running ? "Generating…" : "Generate"}
          </button>
          <span className="text-xs text-slate-500">
            Small batches, filtered after every one and refilled until the target is met.
            Duplicates are shown as rejected by default — never hidden. Max {maxRequested} per job.
            Web grounding (if on) runs once per job and is reused by every batch.
          </span>
        </div>

        {running && (
          <p className="text-xs text-slate-500">
            Running. You can close this tab — the job is saved and can be resumed.
          </p>
        )}
      </section>

      {progress && (
        <div
          className={cn(
            "rounded-lg border px-3 py-2 text-sm",
            progress.done ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-sky-200 bg-sky-50 text-sky-900",
          )}
        >
          {progress.done ? (
            <>
              {progress.groundingCostUsd != null && progress.groundingCostUsd > 0 && (
                <>
                  Grounded
                  {progress.groundingCached ? " (cached)" : ""} for ~$
                  {progress.groundingCostUsd.toFixed(4)} ·{" "}
                </>
              )}
              Target <strong>{progress.requestedCount}</strong> — <strong>{progress.acceptedCount}</strong>{" "}
              accepted in <strong>{progress.round}</strong> call{progress.round === 1 ? "" : "s"} of{" "}
              {progress.batchSize}/batch. <strong>{progress.producedCount}</strong> generated in total,{" "}
              <strong>{progress.duplicateCount}</strong> flagged as duplicate
              {progress.duplicateCount === 1 ? "" : "s"} (rejected by default, shown below).
              {progress.error && <> {progress.error}</>}{" "}
              <span className="text-slate-500">The generated set is open below.</span>
            </>
          ) : (
            <>
              Batch <strong>{progress.round + 1}</strong>
              {progress.totalPlannedCalls > 1 ? <> of ~{progress.totalPlannedCalls}</> : null} ·
              accepted <strong>{progress.acceptedCount}</strong> of{" "}
              <strong>{progress.requestedCount}</strong> ·{" "}
              <strong>{progress.duplicateCount}</strong> flagged. Generating the next batch…
            </>
          )}
        </div>
      )}

      {/* The batch view: ALL questions from one generation together, opened
          automatically and refreshed after every round. */}
      {batchJobId && (
        <div id="batch-review" className="scroll-mt-4">
          <BatchReview
            key={batchJobId}
            jobId={batchJobId}
            refreshKey={batchRefresh}
            sets={sets}
            categories={categories}
          />
        </div>
      )}

      <section className="flex flex-col gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Recent jobs</h2>

        {jobs.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-500">
            No generation jobs yet.
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {jobs.map((job) => (
              <li
                key={job.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-slate-200 bg-white px-4 py-2.5"
              >
                <span
                  className={cn(
                    "rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                    STATUS_TONE[job.status] ?? "bg-slate-100 text-slate-600",
                  )}
                >
                  {job.status}
                </span>
                <span className="text-sm font-medium text-slate-900">{job.topic}</span>
                <span className="text-xs text-slate-500">
                  target {job.requestedCount} · accepted {job.acceptedCount} · generated{" "}
                  {job.producedCount} · flagged {job.duplicateCount} · {job.backfillRound} call
                  {job.backfillRound === 1 ? "" : "s"} of {job.batchSize}/batch
                  {job.costUsd != null && ` · ~$${job.costUsd.toFixed(4)}`}
                  {job.groundingCached === 1 && " · grounded (cached)"}
                  {job.groundingCostUsd != null && job.groundingCostUsd > 0 &&
                    ` · grounding ~$${job.groundingCostUsd.toFixed(4)}`}
                  {(job.providerOnly || job.providerOrder) && (
                    <span className="font-mono text-[11px] text-slate-400">
                      {" "}
                      · only:[{job.providerOnly ? JSON.parse(job.providerOnly).join(",") : "any"}]
                      {" "}
                      {job.providerOrder && `order:[${JSON.parse(job.providerOrder as string).join(",")}]`}
                    </span>
                  )}
                </span>
                {job.errorMessage && (
                  <span className="text-xs text-red-600">
                    {job.errorCode && (
                      <span className="mr-1 rounded bg-red-100 px-1 py-0.5 font-mono text-[10px]">
                        {job.errorCode}
                      </span>
                    )}
                    {job.errorMessage}
                  </span>
                )}
                {job.status === "failed" && (
                  <span className="text-[11px] text-slate-400">
                    Details are in the terminal running <code>pnpm dev</code> — lines starting{" "}
                    <code className="font-mono">[qms]</code>.
                  </span>
                )}
                <LocalTime
                  value={job.createdAt}
                  className="ml-auto text-[11px] text-slate-400"
                />
                <button
                  type="button"
                  onClick={() => setBatchJobId(job.id)}
                  className="inline-flex items-center gap-1 rounded-lg bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-200"
                >
                  <Flag className="size-3" />
                  Review batch
                </button>
                {job.status === "queued" && (
                  <button
                    type="button"
                    onClick={() => void createAndRunFrom(job.id)}
                    disabled={running || !configured}
                    className="rounded-lg bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-200 disabled:opacity-50"
                  >
                    Resume
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );

  /** Resume an existing queued job (e.g. after a closed tab). */
  async function createAndRunFrom(jobId: string) {
    setError(null);
    setRunningJobId(jobId);
    setBatchJobId(jobId);
    scrollToBatch();
    try {
      for (let step = 0; step < 6; step++) {
        const res = await fetch(`/api/admin/generation-jobs/${jobId}/step`, { method: "POST" });
        const body = (await res.json()) as { progress?: Progress; error?: { message: string } };
        if (!res.ok || !body.progress) {
          throw new Error(body.error?.message ?? "The generation step failed.");
        }
        setProgress(body.progress);
        await refetch();
        setBatchRefresh((n) => n + 1);
        if (body.progress.done) break;
      }
      scrollToBatch();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setRunningJobId(null);
    }
  }
}

