"use client";

/**
 * Review queue (M10, PLAN.md §9.6).
 *
 * This screen is the ONLY way an AI candidate becomes a question (§2.2). It
 * shows what the model produced, what validation said about it, and — where a
 * duplicate was detected — the question it matched, side by side, so the
 * decision is made with the evidence visible.
 *
 * "Approve & add to bank" runs the candidate through the same funnel as a
 * hand-typed question, so a duplicate that slipped past candidate-time checks is
 * still refused here.
 */

import { AlertTriangle, Check, CheckCheck, Clock, Loader2, X } from "lucide-react";
import { useState } from "react";
import { BackstoryRenderer } from "@/components/backstory/BackstoryRenderer";
import { cn } from "@/lib/utils";

type Candidate = {
  id: string;
  jobId: string;
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
  dedupeBestMatchId: string | null;
  dedupeSimilarity: number | null;
  reviewStatus: string;
  promotedQuestionId: string | null;
  model: string;
  jobTopic: string;
};

const DEDUPE_TONE: Record<string, string> = {
  clean: "bg-emerald-50 text-emerald-700",
  exact_dup: "bg-red-50 text-red-700",
  near_dup: "bg-amber-50 text-amber-700",
  semantic_dup: "bg-amber-50 text-amber-700",
  pending: "bg-slate-100 text-slate-500",
  error: "bg-red-50 text-red-700",
};

export function ReviewQueue({ initial }: { initial: Candidate[] }) {
  const [candidates, setCandidates] = useState<Candidate[]>(initial);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function api<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(path, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
    const body = (await res.json().catch(() => ({}))) as { error?: { message: string } };
    if (!res.ok) throw new Error(body.error?.message ?? "Request failed");
    return body as T;
  }

  async function refetch() {
    const data = await api<{ candidates: Candidate[] }>("/api/admin/candidates?reviewStatus=pending");
    setCandidates(data.candidates);
    setSelected(new Set());
  }

  async function run(action: () => Promise<void>) {
    setError(null);
    setBusy(true);
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  const decide = (id: string, decision: "approved" | "rejected" | "deferred", promote = false) =>
    run(async () => {
      const result = await api<{ questionId?: string }>(`/api/admin/candidates/${id}/review`, {
        method: "POST",
        body: JSON.stringify({ action: decision, promote }),
      });
      setNotice(
        promote && result.questionId
          ? "Added to the question bank as an approved question (not published yet)."
          : `Candidate ${decision}.`,
      );
      await refetch();
    });

  const bulk = (decision: "approved" | "rejected" | "deferred") =>
    run(async () => {
      const ids = [...selected];
      if (ids.length === 0) return;
      const result = await api<{ updated: number }>("/api/admin/candidates/bulk-review", {
        method: "POST",
        body: JSON.stringify({ ids, action: decision }),
      });
      setNotice(`${result.updated} candidate(s) marked ${decision}. Promote them individually when ready.`);
      await refetch();
    });

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900">
          {notice}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <p className="text-xs text-slate-500">
          {candidates.length} pending {candidates.length === 1 ? "candidate" : "candidates"}
        </p>
        {selected.size > 0 && (
          <div className="ml-auto flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void bulk("approved")}
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
            >
              <Check className="size-3.5" />
              Approve {selected.size}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void bulk("rejected")}
              className="inline-flex items-center gap-1.5 rounded-lg bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-100 disabled:opacity-50"
            >
              <X className="size-3.5" />
              Reject {selected.size}
            </button>
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="rounded-lg px-2 py-1.5 text-xs font-medium text-slate-500 hover:bg-slate-100"
            >
              Clear
            </button>
          </div>
        )}
      </div>

      {candidates.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
          Nothing waiting for review.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {candidates.map((candidate) => {
            const options = JSON.parse(candidate.optionsJson) as Array<{ key: string; body: string }>;
            const errors = candidate.validationErrors
              ? (JSON.parse(candidate.validationErrors) as string[])
              : [];
            const isDuplicate = candidate.dedupeStatus !== "clean" && candidate.dedupeStatus !== "pending";

            return (
              <li key={candidate.id} className="rounded-2xl border border-slate-200 bg-white p-4">
                <div className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    checked={selected.has(candidate.id)}
                    onChange={(e) =>
                      setSelected((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(candidate.id);
                        else next.delete(candidate.id);
                        return next;
                      })
                    }
                    aria-label="Select candidate"
                    className="mt-1 size-4 shrink-0"
                  />

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={cn(
                          "rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                          DEDUPE_TONE[candidate.dedupeStatus] ?? "bg-slate-100 text-slate-600",
                        )}
                      >
                        {candidate.dedupeStatus.replace("_", " ")}
                      </span>
                      {candidate.difficulty && (
                        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">
                          {candidate.difficulty}
                        </span>
                      )}
                      {candidate.topic && (
                        <span className="text-[11px] text-slate-500">{candidate.topic}</span>
                      )}
                      <span className="text-[11px] text-slate-400">{candidate.model}</span>
                    </div>

                    {candidate.validationStatus === "invalid" && (
                      <div className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
                        <p className="font-semibold">This candidate did not pass validation</p>
                        <ul className="mt-1 list-disc pl-4">
                          {errors.map((e) => (
                            <li key={e}>{e}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {isDuplicate && (
                      <div className="mt-2 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                        <span>
                          Possible duplicate
                          {candidate.dedupeSimilarity != null &&
                            ` — ${Math.round(candidate.dedupeSimilarity * 100)}% match`}
                          {candidate.dedupeBestMatchId && (
                            <>
                              {" "}
                              with question{" "}
                              <code className="rounded bg-amber-100 px-1">
                                {candidate.dedupeBestMatchId.slice(0, 8)}
                              </code>
                              . Review both before approving.
                            </>
                          )}
                        </span>
                      </div>
                    )}

                    <p className="mt-3 text-sm font-medium leading-6 text-slate-900">{candidate.stem}</p>

                    <ul className="mt-2 flex flex-col gap-1">
                      {options.map((option) => (
                        <li
                          key={option.key}
                          className={cn(
                            "flex items-start gap-2 rounded-lg border px-3 py-1.5 text-sm",
                            option.key === candidate.correctOptionKey
                              ? "border-emerald-300 bg-emerald-50"
                              : "border-slate-200",
                          )}
                        >
                          <span className="font-semibold text-slate-500">{option.key}</span>
                          <span className="text-slate-700">{option.body}</span>
                          {option.key === candidate.correctOptionKey && (
                            <span className="ml-auto text-[10px] font-semibold uppercase text-emerald-700">
                              correct
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>

                    {candidate.explanation && (
                      <p className="mt-3 text-xs text-slate-600">{candidate.explanation}</p>
                    )}

                    {candidate.backstory && (
                      <details className="mt-3">
                        <summary className="cursor-pointer text-xs font-medium text-slate-500 hover:text-slate-800">
                          Backstory
                        </summary>
                        <div className="mt-2 rounded-xl border border-slate-200 bg-slate-50 p-4">
                          <BackstoryRenderer content={candidate.backstory} />
                        </div>
                      </details>
                    )}
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap justify-end gap-2 border-t border-slate-100 pt-3">
                  {candidate.promotedQuestionId ? (
                    <span className="text-xs font-semibold text-emerald-700">
                      Already added to the bank
                    </span>
                  ) : (
                    <>
                      <button
                        type="button"
                        disabled={busy || candidate.validationStatus !== "valid"}
                        onClick={() => void decide(candidate.id, "approved", true)}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-700 disabled:opacity-40"
                        title={
                          candidate.validationStatus !== "valid"
                            ? "Invalid candidates cannot be promoted"
                            : "Approve and add to the question bank"
                        }
                      >
                        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <CheckCheck className="size-3.5" />}
                        Approve &amp; add to bank
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void decide(candidate.id, "approved")}
                        className="rounded-lg bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
                      >
                        Approve only
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void decide(candidate.id, "rejected")}
                        className="rounded-lg bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-100 disabled:opacity-50"
                      >
                        Reject
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void decide(candidate.id, "deferred")}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-200 disabled:opacity-50"
                      >
                        <Clock className="size-3.5" />
                        Defer
                      </button>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
