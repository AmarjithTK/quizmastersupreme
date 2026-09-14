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

type Job = {
  id: string;
  topic: string;
  model: string;
  status: string;
  requestedCount: number;
  producedCount: number;
  validCount: number;
  duplicateCount: number;
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
  producedCount: number;
  validCount: number;
  duplicateCount: number;
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
  categories,
  sets,
}: {
  initialJobs: Job[];
  configured: boolean;
  defaultModel: string;
  categories: Array<{ id: string; title: string }>;
  sets: Array<{ id: string; title: string; status: string; categoryTitle?: string }>;
}) {
  const [jobs, setJobs] = useState<Job[]>(initialJobs);
  const [topic, setTopic] = useState("");
  const [brief, setBrief] = useState("");
  const [target, setTarget] = useState("");
  const [sources, setSources] = useState("");
  const [count, setCount] = useState("10");
  const [difficulty, setDifficulty] = useState("medium");
  const [model, setModel] = useState(defaultModel);
  const [categoryId, setCategoryId] = useState("");

  /** The job whose generated set is open in the batch view below. */
  const [batchJobId, setBatchJobId] = useState<string | null>(null);

  const [runningJobId, setRunningJobId] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refetch() {
    const res = await fetch("/api/admin/generation-jobs");
    if (!res.ok) return;
    const body = (await res.json()) as { jobs: Job[] };
    setJobs(body.jobs);
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
          requestedCount: Number(count) || 10,
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

      // Advance until the job says it is done. Each call is one bounded step.
      for (let step = 0; step < 6; step++) {
        const res = await fetch(`/api/admin/generation-jobs/${jobId}/step`, { method: "POST" });
        const body = (await res.json()) as { progress?: Progress; error?: { message: string } };
        if (!res.ok || !body.progress) {
          throw new Error(body.error?.message ?? "The generation step failed.");
        }
        setProgress(body.progress);
        await refetch();
        if (body.progress.done) break;
      }

      setTopic("");
      setBrief("");
      setTarget("");
      setSources("");
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

        <div className="grid gap-3 sm:grid-cols-3">
          <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
            How many
            <select value={count} onChange={(e) => setCount(e.target.value)} className={field}>
              {[5, 10, 15, 20, 25].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
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
            Small batches dedupe better and fail cheaper. Max 25 per job.
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
              Job finished: <strong>{progress.producedCount}</strong> candidates produced,{" "}
              <strong>{progress.validCount}</strong> valid,{" "}
              <strong>{progress.duplicateCount}</strong> flagged as duplicates.
              {progress.error && <> {progress.error}</>}{" "}
              <a href="/admin/review" className="font-medium underline underline-offset-2">
                Review them →
              </a>
            </>
          ) : (
            <>Step complete — status is “{progress.status}”. Continuing…</>
          )}
        </div>
      )}

      {/* The batch view: ALL questions from one generation together. */}
      {batchJobId && (
        <BatchReview
          key={batchJobId}
          jobId={batchJobId}
          sets={sets}
          categories={categories}
        />
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
                  asked {job.requestedCount} · produced {job.producedCount} · valid {job.validCount} · dup{" "}
                  {job.duplicateCount}
                  {job.costUsd != null && ` · ~$${job.costUsd.toFixed(4)}`}
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
                <span className="ml-auto text-[11px] text-slate-400">
                  {new Date(job.createdAt).toLocaleString("en-IN", {
                    dateStyle: "short",
                    timeStyle: "short",
                  })}
                </span>
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
    try {
      for (let step = 0; step < 6; step++) {
        const res = await fetch(`/api/admin/generation-jobs/${jobId}/step`, { method: "POST" });
        const body = (await res.json()) as { progress?: Progress; error?: { message: string } };
        if (!res.ok || !body.progress) {
          throw new Error(body.error?.message ?? "The generation step failed.");
        }
        setProgress(body.progress);
        await refetch();
        if (body.progress.done) break;
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setRunningJobId(null);
    }
  }
}

