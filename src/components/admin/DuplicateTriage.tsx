"use client";

/**
 * Duplicate triage (M11, PLAN.md §9.7).
 *
 * Both questions are shown side by side with the similarity score, because the
 * decision "are these the same question?" cannot be made from a number. Nothing
 * here deletes anything: resolving a flag records a decision, and removing a
 * question stays a separate, explicit action in the bank.
 */

import { AlertTriangle, Check, ScanSearch, X } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

type Flag = {
  id: string;
  questionId: string;
  matchedQuestionId: string;
  layer: string;
  similarity: number;
  questionStem: string;
  matchedStem: string;
  questionStatus: string;
  matchedStatus: string;
};

type Thresholds = {
  jaccardReject: number;
  jaccardReview: number;
  simhashMaxDistance: number;
  semanticReject: number;
  semanticReview: number;
};

export function DuplicateTriage({
  initialFlags,
  thresholds,
}: {
  initialFlags: Flag[];
  thresholds: Thresholds;
}) {
  const [flags, setFlags] = useState<Flag[]>(initialFlags);
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
    const data = await api<{ flags: Flag[] }>("/api/admin/duplicates?status=open");
    setFlags(data.flags);
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

  const resolve = (id: string, action: "confirmed" | "dismissed" | "merged") =>
    run(async () => {
      await api(`/api/admin/duplicates/${id}/resolve`, {
        method: "POST",
        body: JSON.stringify({ action }),
      });
      setNotice(`Flag ${action}. The questions themselves were not changed.`);
      await refetch();
    });

  const sweep = () =>
    run(async () => {
      const { result } = await api<{ result: { scanned: number; flagsCreated: number } }>(
        "/api/admin/duplicates/sweep",
        { method: "POST", body: JSON.stringify({ limit: 100 }) },
      );
      setNotice(
        `Swept ${result.scanned} questions and raised ${result.flagsCreated} new flag(s).`,
      );
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
          {flags.length} open {flags.length === 1 ? "flag" : "flags"}
        </p>
        <button
          type="button"
          disabled={busy}
          onClick={() => void sweep()}
          className="ml-auto inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          <ScanSearch className="size-4" />
          {busy ? "Scanning…" : "Scan the bank (100 questions)"}
        </button>
      </div>

      <p className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-[11px] text-slate-500">
        Flagging bands: Jaccard ≥ <strong>{thresholds.jaccardReject}</strong> is a near-duplicate,
        ≥ <strong>{thresholds.jaccardReview}</strong> needs a look. Nothing is auto-deleted —
        a flag is a question for you, not a verdict.
      </p>

      {flags.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
          No open duplicate flags. Run a scan to check the existing bank.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {flags.map((flag) => (
            <li key={flag.id} className="rounded-2xl border border-slate-200 bg-white p-4">
              <div className="flex flex-wrap items-center gap-2">
                <AlertTriangle className="size-4 text-amber-500" />
                <span className="text-sm font-semibold text-slate-900">
                  {Math.round(flag.similarity * 100)}% similar
                </span>
                <span
                  className={cn(
                    "rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                    flag.similarity >= thresholds.jaccardReject
                      ? "bg-red-50 text-red-700"
                      : "bg-amber-50 text-amber-700",
                  )}
                >
                  {flag.layer}
                </span>
                <a
                  href={`/admin/questions?focus=${flag.questionId}`}
                  className="ml-auto text-[11px] font-medium text-slate-500 underline underline-offset-2 hover:text-slate-800"
                >
                  Open in bank
                </a>
              </div>

              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                    Question A · {flag.questionStatus}
                  </p>
                  <p className="mt-1 text-sm leading-6 text-slate-800">{flag.questionStem}</p>
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                    Question B · {flag.matchedStatus}
                  </p>
                  <p className="mt-1 text-sm leading-6 text-slate-800">{flag.matchedStem}</p>
                </div>
              </div>

              <div className="mt-3 flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void resolve(flag.id, "confirmed")}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-100 disabled:opacity-50"
                  title="These are the same question — one should be archived"
                >
                  <Check className="size-3.5" />
                  Same question
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void resolve(flag.id, "dismissed")}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
                  title="Different questions after all"
                >
                  <X className="size-3.5" />
                  Different
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void resolve(flag.id, "merged")}
                  className="rounded-lg bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-200 disabled:opacity-50"
                >
                  Merged by hand
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
