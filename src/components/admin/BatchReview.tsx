"use client";

/**
 * The batch review — one generation, one window (PLAN.md §12.6).
 *
 * All candidates from a single AI job are shown together. The admin rejects
 * bad/repeated/not-good-enough questions one by one; everything that survives
 * IS the approved set, and is committed in one action to either an existing
 * Q Set or a freshly created one.
 *
 * Semantics: within a batch, "kept" is the default. Rejecting sets
 * reviewStatus=rejected (the same server-side field the queue uses); the
 * commit endpoint promotes everything that is NOT rejected.
 */

import { useEffect, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CopyX,
  Flag,
  FolderPlus,
  Loader2,
  Save,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";

type Candidate = {
  id: string;
  batchIndex: number | null;
  stem: string;
  optionsJson: string;
  correctOptionKey: string;
  explanation: string | null;
  backstory: string | null;
  difficulty: string | null;
  topic: string | null;
  validationStatus: string;
  validationErrors: string | null;
  dedupeStatus: string;
  dedupeSimilarity: number | null;
  dedupeBestMatchId: string | null;
  dedupeDetail: string | null;
  reviewStatus: string;
  promotedQuestionId: string | null;
};

type SetOption = { id: string; title: string; status: string; categoryTitle?: string };
type CategoryOption = { id: string; title: string };

type JobDetail = {
  job: { id: string; topic: string; model: string; status: string; committedSetId: string | null; committedAt: number | null };
  candidates: Candidate[];
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

function dedupeBadge(candidate: Candidate): { label: string; tone: string } | null {
  const map: Record<string, string> = {
    exact_dup: "border-red-200 bg-red-50 text-red-700",
    near_dup: "border-amber-200 bg-amber-50 text-amber-800",
    semantic_dup: "border-amber-200 bg-amber-50 text-amber-800",
  };
  const tone = map[candidate.dedupeStatus];
  if (!tone) return null;
  const extra =
    candidate.dedupeSimilarity != null
      ? ` (${Math.round(candidate.dedupeSimilarity * 100)}%)`
      : "";
  const labels: Record<string, string> = {
    exact_dup: "Duplicate",
    near_dup: "Possible duplicate",
    semantic_dup: "Possible duplicate",
  };
  return { label: `${labels[candidate.dedupeStatus]}${extra}`, tone };
}

export function BatchReview({
  jobId,
  initialTopic,
  sets,
  categories,
  onCommitted,
}: {
  jobId: string;
  initialTopic?: string;
  sets: SetOption[];
  categories: CategoryOption[];
  onCommitted?: (outcome: CommitOutcome) => void;
}) {
  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyCandidateId, setBusyCandidateId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

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
      setDetail((await res.json()) as JobDetail);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Could not load the generated questions.");
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

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
  const rejected = new Set(candidates.filter((c) => c.reviewStatus === "rejected").map((c) => c.id));
  const kept = candidates.filter((c) => !rejected.has(c.id) && !c.promotedQuestionId);
  const alreadyPromoted = candidates.filter((c) => c.promotedQuestionId);
  const duplicates = candidates.filter((c) =>
    ["exact_dup", "near_dup", "semantic_dup"].includes(c.dedupeStatus),
  );

  async function reject(candidateId: string) {
    setBusyCandidateId(candidateId);
    try {
      const res = await fetch(`/api/admin/candidates/${candidateId}/review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "rejected" }),
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: { message: string } };
        throw new Error(body.error?.message ?? "Reject failed.");
      }
      setDetail((prev) =>
        prev
          ? {
              ...prev,
              candidates: prev.candidates.map((c) =>
                c.id === candidateId ? { ...c, reviewStatus: "rejected" } : c,
              ),
            }
          : prev,
      );
    } catch (e) {
      setCommitError(e instanceof Error ? e.message : "Reject failed.");
    } finally {
      setBusyCandidateId(null);
    }
  }

  function unReject(candidateId: string) {
    setDetail((prev) =>
      prev
        ? {
            ...prev,
            candidates: prev.candidates.map((c) =>
              c.id === candidateId ? { ...c, reviewStatus: "pending" } : c,
            ),
          }
        : prev,
    );
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

      const res = await fetch(`/api/admin/generation-jobs/${jobId}/commit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          commitMode === "existing"
            ? { targetSetId }
            : {
                newSet: {
                  title: newTitle.trim(),
                  categoryId: newCategoryId,
                  mode: newMode,
                  difficulty: newDifficulty,
                },
              },
        ),
      });
      const body = (await res.json()) as { outcome?: CommitOutcome; error?: { message: string } };
      if (!res.ok || !body.outcome) {
        throw new Error(body.error?.message ?? "Could not add the questions to the Q Set.");
      }
      setOutcome(body.outcome);
      onCommitted?.(body.outcome);
      setDetail((prev) => (prev ? { ...prev, job: { ...prev.job, committedSetId: (body.outcome!.createdSet?.id ?? targetSetId) ?? null, committedAt: Date.now() } } : prev));
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

  return (
    <section className="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold text-slate-900">
            <Flag className="size-4 text-slate-400" />
            Generated set
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">
            {detail.job.topic} · {detail.job.model} · {candidates.length} questions · job{" "}
            {jobId.slice(0, 8)}
            {detail.job.committedSetId && (
              <span className="ml-1 text-emerald-600">
                — added to “{committedSetTitle}”
              </span>
            )}
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-[11px]">
          <span className="rounded bg-slate-100 px-2 py-1 font-medium text-slate-600">
            {candidates.length} generated
          </span>
          <span
            className={cn(
              "rounded px-2 py-1 font-medium",
              duplicates.length > 0
                ? "bg-amber-100 text-amber-800"
                : "bg-emerald-100 text-emerald-700",
            )}
          >
            {duplicates.length} duplicate(s) flagged
          </span>
          <span className="rounded bg-slate-100 px-2 py-1 font-medium text-slate-600">
            {rejected.size} rejected
          </span>
          <span className="rounded bg-emerald-100 px-2 py-1 font-medium text-emerald-700">
            {kept.length} approved
          </span>
        </div>
      </header>

      {/*
        Duplicate filtration: exact matches and near/semantic-looking duplicates
        are flagged here for a human decision — layer-1 exact is auto-flagged by
        the funnel, everything fuzzy is presented, never auto-deleted (§13.6).
      */}
      {duplicates.length > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>
            {duplicates.length} question(s) were flagged as duplicates or possible duplicates
            against the bank. Nothing is removed automatically — review them below and reject
            the ones that repeat an existing question or each other.
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
        {candidates.map((candidate) => {
          const isRejected = rejected.has(candidate.id);
          const badge = dedupeBadge(candidate);
          const isExpanded = expanded.has(candidate.id);
          const invalid =
            candidate.validationStatus !== "valid"
              ? (JSON.parse(candidate.validationErrors ?? "[]") as string[])
              : [];

          return (
            <div
              key={candidate.id}
              className={cn(
                "rounded-xl border bg-white transition-opacity",
                isRejected
                  ? "border-slate-200 opacity-50"
                  : badge
                    ? "border-amber-300"
                    : "border-slate-200",
              )}
            >
              <div className="flex flex-col gap-2 p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className={cn("text-sm font-medium leading-6 text-slate-900", isRejected && "line-through")}>
                    <span className="mr-1.5 text-xs font-semibold text-slate-400">
                      Q{candidate.batchIndex != null ? candidate.batchIndex + 1 : "–"}
                    </span>
                    {candidate.stem}
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      if (isRejected) unReject(candidate.id);
                      else void reject(candidate.id);
                    }}
                    disabled={busyCandidateId !== null}
                    className={cn(
                      "inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-semibold transition-colors",
                      isRejected
                        ? "border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                        : "border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100",
                    )}
                  >
                    {busyCandidateId === candidate.id ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : isRejected ? (
                      <CheckCircle2 className="size-3.5" />
                    ) : (
                      <CopyX className="size-3.5" />
                    )}
                    {isRejected ? "Keep" : "Reject"}
                  </button>
                </div>

                <div className="flex flex-wrap gap-1.5 text-[10px]">
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 font-medium text-slate-600">
                    Ans {candidate.correctOptionKey}
                  </span>
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 font-medium text-slate-600">
                    {candidate.difficulty ?? "medium"}
                  </span>
                  {badge && (
                    <span className={cn("rounded px-1.5 py-0.5 font-medium", badge.tone)}>
                      {badge.label}
                    </span>
                  )}
                  {invalid.length > 0 && (
                    <span className="rounded bg-red-100 px-1.5 py-0.5 font-medium text-red-700">
                      {invalid.length} issue(s)
                    </span>
                  )}
                  {candidate.promotedQuestionId && (
                    <span className="rounded bg-emerald-100 px-1.5 py-0.5 font-medium text-emerald-700">
                      already in bank
                    </span>
                  )}
                </div>

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

                {isRejected && (
                  <p className="text-xs text-slate-400">
                    Rejected — will not be added to the Q Set.
                  </p>
                )}

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
                    {invalid.length > 0 && (
                      <ul className="list-disc pl-4 text-red-700">
                        {invalid.map((issue) => (
                          <li key={issue}>{issue}</li>
                        ))}
                      </ul>
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

      {/* ── the approved set stays together ────────────────────────────────── */}
      {kept.length > 0 && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-4">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-emerald-900">
            <CheckCircle2 className="size-4" />
            Final approved set — {kept.length} question{kept.length === 1 ? "" : "s"}
          </h3>
          <ul className="mt-2 flex flex-col gap-1">
            {kept.map((candidate) => (
              <li key={candidate.id} className="text-xs leading-5 text-emerald-900/90">
                <span className="mr-1.5 font-semibold text-slate-400">
                  Q{candidate.batchIndex != null ? candidate.batchIndex + 1 : "–"}
                </span>
                {candidate.stem}
              </li>
            ))}
          </ul>
          {alreadyPromoted.length > 0 && (
            <p className="mt-2 text-[11px] text-slate-500">
              {alreadyPromoted.length} already exist in the bank and are included as-is.
            </p>
          )}
        </div>
      )}

      {kept.length === 0 && alreadyPromoted.length === 0 && (
        <p className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
          Nothing left — every question was rejected. You can generate again.
        </p>
      )}

      {/* ── commit to a Q Set ──────────────────────────────────────────────── */}
      {outcome ? (
        <div className="flex items-start gap-2 rounded-xl border border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-900">
          <CheckCircle2 className="mt-0.5 size-5 shrink-0" />
          <div>
            <p className="font-semibold">
              {outcome.promoted.length} question{outcome.promoted.length === 1 ? "" : "s"} added to “
              {outcome.createdSet?.title ?? sets.find((s) => s.id === targetSetId)?.title ??
                "Q Set"}
              ”.
            </p>
            {outcome.failed.length > 0 && (
              <p className="mt-1 text-xs text-amber-800">
                {outcome.failed.length} could not be added:{" "}
                {outcome.failed.map((f) => f.reason).join("; ")}
              </p>
            )}
            <p className="mt-2 text-xs">
              <a
                href={`/admin/sets/${outcome.createdSet?.id ?? targetSetId}`}
                className="font-medium underline underline-offset-2"
              >
                Open the Q Set →
              </a>
            </p>
          </div>
        </div>
      ) : (
        (kept.length > 0 || alreadyPromoted.length > 0) && (
          <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              <Save className="size-4" />
              Add the entire approved set to a Q Set
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
                    className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
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
                    className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
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
                disabled={committing}
                className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                {committing ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                {committing
                  ? "Adding…"
                  : `Add ${kept.length} approved question${kept.length === 1 ? "" : "s"} to Q Set`}
              </button>
            </div>
          </div>
        )
      )}
    </section>
  );
}