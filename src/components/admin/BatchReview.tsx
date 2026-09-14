"use client";

/**
 * The batch review — one generation, one window (REVAMP-PLAN.md §3.4).
 *
 * All questions from a single AI job are shown together. Duplicates were
 * already filtered against the bank when they were generated, so the only job
 * here is taste: reject anything you do not want, and the rest is committed in
 * one action to an existing Q Set or a brand-new one.
 *
 * Committing inserts the kept questions as ACTIVE questions — attached to a
 * published set they are playable immediately. There is no per-question publish
 * step.
 */

import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CopyX,
  Flag,
  FolderPlus,
  Loader2,
  RefreshCw,
  Save,
} from "lucide-react";
import { cn } from "@/lib/utils";

type Batch = {
  batchNo: number;
  status: string;
  asked: number;
  produced: number;
  accepted: number;
  flagged: number;
  promptTokens: number | null;
  completionTokens: number | null;
  costUsd: number | null;
  durationMs: number | null;
  errorCode: string | null;
  errorMessage: string | null;
};

type Candidate = {
  id: string;
  batchIndex: number | null;
  batchNo: number | null;
  stem: string;
  optionsJson: string;
  correctOptionKey: string;
  explanation: string | null;
  backstory: string | null;
  difficulty: string | null;
  topic: string | null;
  rejected: number;
  /** 'clean' | 'exact_dup' | 'near_dup' | 'possible_dup' */
  dedupeStatus: string;
  dedupeMatchedQuestionId: string | null;
  dedupeMatchedStem: string | null;
  dedupeSimilarity: number | null;
  dedupeReason: string | null;
};

type SetOption = { id: string; title: string; status: string; categoryTitle?: string };
type CategoryOption = { id: string; title: string };

type JobDetail = {
  job: {
    id: string;
    topic: string;
    model: string;
    status: string;
    requestedCount: number;
    acceptedCount: number;
    producedCount: number;
    duplicateCount: number;
    batchSize: number;
    maxCalls: number;
    backfillRound: number;
    committedSetId: string | null;
    committedAt: number | null;
  };
  candidates: Candidate[];
  batches: Batch[];
};

type CommitOutcome = {
  jobId: string;
  promoted: Array<{ candidateId: string; questionId: string }>;
  failed: Array<{ candidateId: string; reason: string }>;
  createdSet: { id: string; title: string } | null;
  newSetId: string | null;
  questionIds: string[];
};

function parseOptions(raw: string): Array<{ key: string; body: string }> {
  try {
    return JSON.parse(raw) as Array<{ key: string; body: string }>;
  } catch {
    return [];
  }
}

/**
 * How a flagged duplicate is labelled. Both the certain and the uncertain bands
 * arrive rejected by default — the difference is how loudly we say it.
 */
function duplicateBadge(status: string): { label: string; tone: string } | null {
  switch (status) {
    case "exact_dup":
      return { label: "Duplicate", tone: "border-rose-300 bg-rose-50 text-rose-700" };
    case "near_dup":
      return { label: "Near duplicate", tone: "border-amber-300 bg-amber-50 text-amber-800" };
    case "possible_dup":
      return { label: "Possible duplicate", tone: "border-amber-300 bg-amber-50 text-amber-800" };
    default:
      return null;
  }
}

export function BatchReview({
  jobId,
  refreshKey = 0,
  sets,
  categories,
  onCommitted,
}: {
  jobId: string;
  /** Bumped by the generator after each round so the list fills in live. */
  refreshKey?: number;
  initialTopic?: string;
  sets: SetOption[];
  categories: CategoryOption[];
  onCommitted?: (outcome: CommitOutcome | null) => void;
}) {
  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyCandidateId, setBusyCandidateId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /** Which accepted questions will be added (the reviewer's explicit choice). */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const selectionSignature = useRef<string>("");
  const [regenerating, setRegenerating] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [commitMode, setCommitMode] = useState<"existing" | "new">("existing");
  const [targetSetId, setTargetSetId] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [newCategoryId, setNewCategoryId] = useState("");
  const [newMode, setNewMode] = useState("practice");
  const [newDifficulty, setNewDifficulty] = useState("medium");
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<CommitOutcome | null>(null);

  async function load() {
    setLoadError(null);
    try {
      const res = await fetch(`/api/admin/generation-jobs/${jobId}`);
      if (!res.ok) throw new Error("Could not load the generated questions.");
      const body = (await res.json()) as JobDetail;
      setDetail(body);

      /**
       * Default selection = the first `requestedCount` accepted questions in
       * batch order. That is the D1 auto-trim, done in the UI so the reviewer
       * can see and change it. Re-initialised only when the candidate set
       * actually changed, so a mid-review refresh cannot wipe their choices.
       */
      const acceptedIds = body.candidates
        .filter((candidate) => candidate.rejected !== 1)
        .map((candidate) => candidate.id);
      const signature = acceptedIds.join("|");
      if (signature !== selectionSignature.current) {
        selectionSignature.current = signature;
        setSelected(
          new Set(acceptedIds.slice(0, Math.max(1, body.job.requestedCount))),
        );
      }
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Could not load the generated questions.");
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, refreshKey]);

  if (loadError) {
    return (
      <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
        {loadError}
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500">
        <Loader2 className="size-4 animate-spin" /> Loading generated questions…
      </div>
    );
  }

  const candidates = detail.candidates;
  const rejected = new Set(candidates.filter((c) => c.rejected === 1).map((c) => c.id));
  const kept = candidates.filter((c) => c.rejected !== 1);
  const flagged = candidates.filter((c) => c.dedupeStatus !== "clean");
  const alreadyCommitted = detail.job.committedAt != null;

  // Candidates grouped by the internal call that produced them.
  const byBatch = new Map<number, Candidate[]>();
  for (const candidate of candidates) {
    const key = candidate.batchNo ?? 0;
    const list = byBatch.get(key);
    if (list) list.push(candidate);
    else byBatch.set(key, [candidate]);
  }
  const grouped = [...byBatch.entries()].sort((a, b) => a[0] - b[0]);
  const batchMeta = new Map(detail.batches.map((batch) => [batch.batchNo, batch]));

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function toggleReject(candidate: Candidate) {
    const next = candidate.rejected !== 1;
    setBusyCandidateId(candidate.id);
    try {
      const res = await fetch(`/api/admin/candidates/${candidate.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rejected: next }),
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: { message: string } };
        throw new Error(body.error?.message ?? "Could not save that decision.");
      }
      setDetail((prev) =>
        prev
          ? {
              ...prev,
              candidates: prev.candidates.map((c) =>
                c.id === candidate.id ? { ...c, rejected: next ? 1 : 0 } : c,
              ),
            }
          : prev,
      );
      setSelected((prev) => {
        const updated = new Set(prev);
        if (next) updated.delete(candidate.id);
        else updated.add(candidate.id);
        return updated;
      });
    } catch (e) {
      setCommitError(e instanceof Error ? e.message : "Could not save that decision.");
    } finally {
      setBusyCandidateId(null);
    }
  }

  /**
   * Redo one batch: supersede its questions, then drive the job until the
   * replacement batch has been produced, and reload. One weak batch costs one
   * call instead of the whole job.
   */
  async function regenerate(batchNo: number) {
    setRegenerating(batchNo);
    setNotice(null);
    setCommitError(null);
    try {
      const res = await fetch(
        `/api/admin/generation-jobs/${jobId}/batches/${batchNo}/regenerate`,
        { method: "POST" },
      );
      if (!res.ok) {
        const body = (await res.json()) as { error?: { message: string } };
        throw new Error(body.error?.message ?? "Could not regenerate that batch.");
      }

      // Fill the gap: advance the job until it is terminal again.
      for (let step = 0; step < 60; step++) {
        const stepRes = await fetch(`/api/admin/generation-jobs/${jobId}/step`, { method: "POST" });
        const stepBody = (await stepRes.json()) as { progress?: { done: boolean } };
        if (!stepRes.ok || !stepBody.progress) break;
        if (stepBody.progress.done) break;
      }

      setNotice(`Batch ${batchNo} superseded — a replacement batch was generated.`);
      await load();
      onCommitted?.(null);
    } catch (e) {
      setCommitError(e instanceof Error ? e.message : "Could not regenerate that batch.");
    } finally {
      setRegenerating(null);
    }
  }

  async function commit() {
    setCommitting(true);
    setCommitError(null);
    try {
      if (commitMode === "existing") {
        if (!targetSetId) throw new Error("Choose a Q Set to add the questions to.");
      } else {
        if (!newTitle.trim() || !newCategoryId) {
          throw new Error("A title and a subject are required for a new Q Set.");
        }
      }

      const chosen = [...selected];
      if (chosen.length === 0) throw new Error("Select at least one question to add.");

      const res = await fetch(`/api/admin/generation-jobs/${jobId}/commit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          candidateIds: chosen,
          ...(commitMode === "existing"
            ? { targetSetId }
            : {
                newSet: {
                  title: newTitle.trim(),
                  categoryId: newCategoryId,
                  mode: newMode,
                  difficulty: newDifficulty,
                },
              }),
        }),
      });
      const body = (await res.json()) as { outcome?: CommitOutcome; error?: { message: string } };
      if (!res.ok || !body.outcome) {
        throw new Error(body.error?.message ?? "Could not add the questions to the Q Set.");
      }
      setOutcome(body.outcome);
      onCommitted?.(body.outcome);
      void load();
    } catch (e) {
      setCommitError(e instanceof Error ? e.message : "Could not add the questions to the Q Set.");
    } finally {
      setCommitting(false);
    }
  }

  const committedSetTitle =
    detail.job.committedSetId && !outcome
      ? sets.find((s) => s.id === detail.job.committedSetId)?.title ?? "a Q Set"
      : outcome?.createdSet?.title ?? sets.find((s) => s.id === targetSetId)?.title;

  /** Per-batch header: what that internal call did, and its regenerate action. */
  function batchHeader(batchNo: number, group: Candidate[]) {
    const meta = batchMeta.get(batchNo);
    const canRegenerate =
      !alreadyCommitted && meta != null && meta.status !== "superseded" && meta.status !== "running";

    return (
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
        <span className="rounded bg-slate-900 px-2 py-0.5 text-[11px] font-semibold text-white">
          {batchNo === 0 ? "Batch —" : `Batch ${batchNo}`}
        </span>
        <span className="text-[11px] text-slate-600">
          {meta
            ? `asked ${meta.asked} · accepted ${meta.accepted} · flagged ${meta.flagged}`
            : `${group.length} question${group.length === 1 ? "" : "s"}`}
        </span>
        {meta?.costUsd != null && (
          <span className="text-[11px] text-slate-400">
            · ~${meta.costUsd.toFixed(4)}
            {meta.durationMs != null && ` · ${(meta.durationMs / 1000).toFixed(1)}s`}
          </span>
        )}
        {meta?.status === "superseded" && (
          <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600">
            superseded
          </span>
        )}
        {canRegenerate && (
          <button
            type="button"
            onClick={() => void regenerate(batchNo)}
            disabled={regenerating !== null}
            title="Discard this batch's questions and generate replacements (kept for audit)"
            className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-50"
          >
            {regenerating === batchNo ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
            {regenerating === batchNo ? "Regenerating…" : "Regenerate this batch"}
          </button>
        )}
      </div>
    );
  }

  return (
    <section className="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold text-slate-900">
            <Flag className="size-4 text-slate-400" />
            Generated set
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">
            {detail.job.topic} · {detail.job.model} · {candidates.length} question
            {candidates.length === 1 ? "" : "s"} · job {jobId.slice(0, 8)}
            {detail.job.committedSetId && (
              <span className="ml-1 text-emerald-600">— added to “{committedSetTitle}”</span>
            )}
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-[11px]">
          <span className="rounded bg-slate-100 px-2 py-1 font-medium text-slate-600">
            asked {detail.job.requestedCount} · delivered {detail.job.producedCount}
          </span>
          <span
            className={cn(
              "rounded px-2 py-1 font-medium",
              flagged.length > 0 ? "bg-amber-100 text-amber-800" : "bg-emerald-100 text-emerald-700",
            )}
          >
            {flagged.length} flagged as duplicate{flagged.length === 1 ? "" : "s"}
          </span>
          <span className="rounded bg-slate-100 px-2 py-1 font-medium text-slate-600">
            {rejected.size} rejected
          </span>
          <span className="rounded bg-emerald-100 px-2 py-1 font-medium text-emerald-700">
            {kept.length} kept
          </span>
        </div>
      </header>

      {flagged.length > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>
            <strong className="font-semibold">
              {flagged.length} question{flagged.length === 1 ? "" : "s"}
            </strong>{" "}
            already exist in the bank (in a Q Set or the question bank). They are shown below —
            never hidden — and arrive <strong>rejected by default</strong>. Each one names the
            existing question it matched. Press <strong>Accept</strong> if you judge it genuinely
            different and it becomes eligible to add.
          </span>
        </div>
      )}

      {/* ── every generated question, together ─────────────────────────────── */}
      <div className="flex flex-col gap-3">
        {candidates.length === 0 && (
          <p className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
            This job produced no candidates.
          </p>
        )}
        {grouped.map(([batchNo, group]) => (
          <div key={batchNo} className="flex flex-col gap-3">
            {batchHeader(batchNo, group)}
            {group.map((candidate) => {
          const isRejected = rejected.has(candidate.id);
          const isExpanded = expanded.has(candidate.id);
          const isFlagged = candidate.dedupeStatus !== "clean";
          const badge = duplicateBadge(candidate.dedupeStatus);

          return (
            <div
              key={candidate.id}
              className={cn(
                "rounded-xl border bg-white transition-opacity",
                isRejected ? "border-slate-200 opacity-60" : "border-slate-200",
              )}
            >
              <div className="flex flex-col gap-2 p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  {!isRejected && (
                    <input
                      type="checkbox"
                      checked={selected.has(candidate.id)}
                      onChange={() => toggleSelected(candidate.id)}
                      disabled={alreadyCommitted}
                      aria-label={`Include this question in the Q Set: ${candidate.stem}`}
                      className="mt-1.5 size-4 shrink-0 rounded border-slate-300 accent-slate-900"
                    />
                  )}
                  <p
                    className={cn(
                      "min-w-40 flex-1 text-sm font-medium leading-6 text-slate-900",
                      isRejected && "text-slate-500",
                    )}
                  >
                    <span className="mr-1.5 text-xs font-semibold text-slate-400">
                      Q{candidate.batchIndex != null ? candidate.batchIndex + 1 : "–"}
                    </span>
                    {candidate.stem}
                  </p>
                  <button
                    type="button"
                    onClick={() => void toggleReject(candidate)}
                    disabled={busyCandidateId !== null || alreadyCommitted}
                    className={cn(
                      "inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-semibold transition-colors disabled:opacity-50",
                      isRejected
                        ? "border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                        : "border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100",
                    )}
                    title={
                      isRejected
                        ? isFlagged
                          ? "Accept anyway — makes this question eligible for the Q Set"
                          : "Keep this question"
                        : "Reject — it will not be added"
                    }
                  >
                    {busyCandidateId === candidate.id ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : isRejected ? (
                      <CheckCircle2 className="size-3.5" />
                    ) : (
                      <CopyX className="size-3.5" />
                    )}
                    {isRejected ? (isFlagged ? "Accept" : "Keep") : "Reject"}
                  </button>
                </div>

                <div className="flex flex-wrap gap-1.5 text-[10px]">
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 font-medium text-slate-600">
                    Ans {candidate.correctOptionKey}
                  </span>
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 font-medium text-slate-600">
                    {candidate.difficulty ?? "medium"}
                  </span>
                  {candidate.topic && (
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 font-medium text-slate-600">
                      {candidate.topic}
                    </span>
                  )}
                  {badge && (
                    <span className={cn("rounded border px-1.5 py-0.5 font-semibold", badge.tone)}>
                      {badge.label} · rejected by default
                    </span>
                  )}
                  {isFlagged && !isRejected && (
                    <span className="rounded border border-emerald-300 bg-emerald-50 px-1.5 py-0.5 font-semibold text-emerald-700">
                      accepted by you
                    </span>
                  )}
                </div>

                {/*
                  A flagged question is NEVER hidden: it states why it was flagged
                  and shows the existing question it matched, so the decision can be
                  made with the evidence in front of the reviewer.
                */}
                {isFlagged && (
                  <div className={cn("flex flex-col gap-1 rounded-lg border px-3 py-2 text-xs", badge?.tone)}>
                    <p className="font-semibold">
                      {badge?.label ?? "Flagged"} — rejected by default
                    </p>
                    {candidate.dedupeReason && <p>{candidate.dedupeReason}</p>}
                    {candidate.dedupeMatchedStem && (
                      <p className="leading-5">
                        <span className="font-semibold">
                          {candidate.dedupeMatchedQuestionId
                            ? "Existing question it matched:"
                            : "Matched in this batch:"}
                        </span>{" "}
                        “{candidate.dedupeMatchedStem}”
                      </p>
                    )}
                    {candidate.dedupeMatchedQuestionId && (
                      <a
                        href={`/admin/questions?q=${encodeURIComponent(candidate.dedupeMatchedStem ?? "")}`}
                        className="w-fit font-medium underline underline-offset-2"
                      >
                        Open the existing question in the bank →
                      </a>
                    )}
                    {isRejected && (
                      <p className="opacity-80">
                        Press <strong>Accept</strong> if this question is genuinely different — it
                        then becomes eligible to add to a Q Set.
                      </p>
                    )}
                  </div>
                )}

                <ul className="grid gap-1 sm:grid-cols-2">
                  {parseOptions(candidate.optionsJson).map((option) => (
                    <li
                      key={option.key}
                      className={cn(
                        "rounded-lg border px-2.5 py-1.5 text-xs text-slate-700",
                        option.key === candidate.correctOptionKey
                          ? "border-emerald-300 bg-emerald-50/50"
                          : "border-slate-100 bg-slate-50/50",
                      )}
                    >
                      <span className="mr-1.5 font-semibold text-slate-400">{option.key}.</span>
                      {option.body}
                    </li>
                  ))}
                </ul>

                <button
                  type="button"
                  onClick={() =>
                    setExpanded((prev) => {
                      const next = new Set(prev);
                      if (next.has(candidate.id)) next.delete(candidate.id);
                      else next.add(candidate.id);
                      return next;
                    })
                  }
                  className="inline-flex w-fit items-center gap-1 text-xs font-medium text-slate-500 hover:text-slate-700"
                >
                  {isExpanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
                  {isExpanded ? "Hide" : "Show"} explanation &amp; backstory
                </button>

                {isExpanded && (
                  <div className="flex flex-col gap-2 rounded-lg bg-slate-50 p-3 text-xs leading-6 text-slate-600">
                    {candidate.explanation && (
                      <p>
                        <span className="font-semibold text-slate-700">Why:</span>{" "}
                        {candidate.explanation}
                      </p>
                    )}
                    {candidate.backstory && (
                      <div>
                        <span className="font-semibold text-slate-700">Backstory:</span>{" "}
                        {candidate.backstory}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
            })}
          </div>
        ))}
      </div>

      {/* ── what will actually be added ────────────────────────────────────── */}
      {kept.length > 0 && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-4">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-emerald-900">
            <CheckCircle2 className="size-4" />
            Will be added — {selected.size} of {kept.length} accepted
          </h3>
          <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
            <button
              type="button"
              onClick={() => setSelected(new Set(kept.map((c) => c.id)))}
              className="rounded border border-emerald-300 bg-white px-2 py-0.5 font-semibold text-emerald-800 hover:bg-emerald-50"
            >
              Select all {kept.length}
            </button>
            <button
              type="button"
              onClick={() =>
                setSelected(
                  new Set(kept.slice(0, Math.max(1, detail.job.requestedCount)).map((c) => c.id)),
                )
              }
              className="rounded border border-emerald-300 bg-white px-2 py-0.5 font-semibold text-emerald-800 hover:bg-emerald-50"
            >
              Exactly the target ({detail.job.requestedCount})
            </button>
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="rounded border border-slate-300 bg-white px-2 py-0.5 font-semibold text-slate-600 hover:bg-slate-50"
            >
              Clear
            </button>
          </div>
          <ul className="mt-2 flex flex-col gap-1">
            {kept
              .filter((candidate) => selected.has(candidate.id))
              .map((candidate) => (
              <li key={candidate.id} className="text-xs leading-5 text-emerald-900/90">
                <span className="mr-1.5 font-semibold text-slate-400">
                  Q{candidate.batchIndex != null ? candidate.batchIndex + 1 : "–"}
                </span>
                {candidate.stem}
                {candidate.dedupeStatus !== "clean" && (
                  <span className="ml-1.5 rounded bg-emerald-100 px-1 py-0.5 text-[10px] font-semibold text-emerald-800">
                    duplicate accepted by you
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {rejected.size > 0 && (
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
          <h3 className="text-sm font-semibold text-slate-700">
            Rejected — {rejected.size} question{rejected.size === 1 ? "" : "s"} (not added)
          </h3>
          <p className="mt-1 text-[11px] text-slate-500">
            Still listed above so you can inspect them; press Accept on any of them to change its
            mind.
          </p>
        </div>
      )}

      {kept.length === 0 && candidates.length > 0 && (
        <p className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
          Nothing is currently accepted — every question was rejected (duplicates arrive rejected by
          default). Accept any that are genuinely different, or generate again.
        </p>
      )}

      {/* ── commit to a Q Set ──────────────────────────────────────────────── */}
      {alreadyCommitted || outcome ? (
        <div className="flex items-start gap-2 rounded-xl border border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-900">
          <CheckCircle2 className="mt-0.5 size-5 shrink-0" />
          <div>
            <p className="font-semibold">
              {outcome
                ? `${outcome.promoted.length} question${outcome.promoted.length === 1 ? "" : "s"} added to “${
                    outcome.createdSet?.title ??
                    sets.find((s) => s.id === targetSetId)?.title ??
                    "Q Set"
                  }”.`
                : `Already added to “${committedSetTitle}”.`}
            </p>
            {outcome && outcome.failed.length > 0 && (
              <p className="mt-1 text-xs text-amber-800">
                {outcome.failed.length} could not be added:{" "}
                {outcome.failed.map((f) => f.reason).join("; ")}
              </p>
            )}
            {(!outcome || commitMode === "new") && (
              <p className="mt-2 text-xs">
                <a
                  href={`/admin/sets/${outcome?.createdSet?.id ?? detail.job.committedSetId}`}
                  className="font-medium underline underline-offset-2"
                >
                  Open the Q Set →
                </a>{" "}
                Publish it and the quiz is live immediately.
              </p>
            )}
          </div>
        </div>
      ) : (
        kept.length > 0 && (
          <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              <Save className="size-4" />
              Add the accepted questions to a Q Set
            </h3>

            <div className="flex flex-wrap gap-2">
              {(
                [
                  ["existing", "Add to an existing Q Set"],
                  ["new", "Create a new Q Set and add"],
                ] as Array<["existing" | "new", string]>
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setCommitMode(value)}
                  className={cn(
                    "rounded-lg border px-3 py-1.5 text-xs font-semibold",
                    commitMode === value
                      ? "border-slate-900 bg-slate-900 text-white"
                      : "border-slate-300 bg-white text-slate-600 hover:bg-slate-100",
                  )}
                >
                  {value === "new" ? <FolderPlus className="mr-1 inline size-3.5" /> : null}
                  {label}
                </button>
              ))}
            </div>

            {commitMode === "existing" ? (
              <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
                Q Set
                <select
                  value={targetSetId}
                  onChange={(e) => setTargetSetId(e.target.value)}
                  className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-900/10"
                >
                  <option value="">Choose a Q Set…</option>
                  {sets.map((set) => (
                    <option key={set.id} value={set.id}>
                      {set.title}
                      {set.categoryTitle ? ` (${set.categoryTitle})` : ""}
                      {set.status === "published" ? "" : ` · ${set.status}`}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
                  New Q Set title *
                  <input
                    value={newTitle}
                    onChange={(e) => setNewTitle(e.target.value)}
                    className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
                    placeholder="Kerala Cyber Security Initiatives"
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
                  Subject *
                  <select
                    value={newCategoryId}
                    onChange={(e) => setNewCategoryId(e.target.value)}
                    className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
                  >
                    <option value="">Choose a subject…</option>
                    {categories.map((category) => (
                      <option key={category.id} value={category.id}>
                        {category.title}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
                  Mode
                  <select
                    value={newMode}
                    onChange={(e) => setNewMode(e.target.value)}
                    className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-900/10"
                  >
                    <option value="practice">Practice</option>
                    <option value="mock">Mock</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
                  Difficulty
                  <select
                    value={newDifficulty}
                    onChange={(e) => setNewDifficulty(e.target.value)}
                    className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-900/10"
                  >
                    {["easy", "medium", "hard", "expert", "mixed"].map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}

            {commitError && (
              <p role="alert" className="text-xs text-red-600">
                {commitError}
              </p>
            )}

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => void commit()}
                disabled={committing || selected.size === 0}
                className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                {committing ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                {committing
                  ? "Adding…"
                  : `Add ${selected.size} selected question${selected.size === 1 ? "" : "s"} to Q Set`}
              </button>
              <span className="text-[11px] text-slate-400">
                Duplicates stay rejected unless you accepted them. Added questions are active
                immediately — publish the set and they play.
              </span>
            </div>
          </div>
        )
      )}

      {!alreadyCommitted && !outcome && kept.length === 0 && candidates.length > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>Keep at least one question to add a batch to a Q Set.</span>
        </div>
      )}
    </section>
  );
}
