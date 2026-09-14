"use client";

/**
 * Set membership manager (M4) — decides which questions are in a quiz set and
 * in what order.
 *
 * Two panes: what is IN the set (orderable, detachable) and a bank search to
 * ADD from. Detaching only removes the link — the question survives for other
 * sets, which is the whole reason the N:M join exists (§6.1).
 */

import { ArrowDown, ArrowUp, Plus, Search, X } from "lucide-react";
import { useState, useTransition } from "react";
import { cn } from "@/lib/utils";

type SetQuestion = {
  questionId: string;
  sortOrder: number;
  stem: string;
  difficulty: string;
  topic: string | null;
  status: string;
  optionCount: number;
};

type BankRow = {
  id: string;
  stem: string;
  difficulty: string;
  topic: string | null;
  status: string;
};

const field =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-900/10";

export function SetQuestionsManager({
  setId,
  initialQuestions,
}: {
  setId: string;
  initialQuestions: SetQuestion[];
}) {
  const [inSet, setInSet] = useState<SetQuestion[]>(initialQuestions);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<BankRow[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [busy, startTransition] = useTransition();
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
    const data = await api<{ questions: SetQuestion[] }>(`/api/admin/sets/${setId}/questions`);
    setInSet(data.questions);
  }

  function run(action: () => Promise<void>) {
    setError(null);
    startTransition(async () => {
      try {
        await action();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Something went wrong");
      }
    });
  }

  const search = () =>
    run(async () => {
      setNotice(null);
      const params = new URLSearchParams({ q: query.trim(), status: "active", pageSize: "25" });
      const data = await api<{ rows: BankRow[] }>(`/api/admin/questions?${params.toString()}`);
      setResults(data.rows);
      setSelected(new Set());
    });

  const attach = (ids: string[]) =>
    run(async () => {
      const res = await api<{ added: number; skipped: number }>(
        `/api/admin/sets/${setId}/questions`,
        { method: "POST", body: JSON.stringify({ questionIds: ids }) },
      );
      setNotice(`Added ${res.added}, skipped ${res.skipped} (already in this set).`);
      setSelected(new Set());
      await refetch();
    });

  const detach = (questionId: string) =>
    run(async () => {
      await api(`/api/admin/sets/${setId}/questions`, {
        method: "DELETE",
        body: JSON.stringify({ questionIds: [questionId] }),
      });
      await refetch();
    });

  const move = (index: number, delta: -1 | 1) =>
    run(async () => {
      const target = index + delta;
      if (target < 0 || target >= inSet.length) return;
      const next = [...inSet];
      const a = next[index]!;
      next[index] = next[target]!;
      next[target] = a;
      await api(`/api/admin/sets/${setId}/questions/reorder`, {
        method: "POST",
        body: JSON.stringify({ questionIds: next.map((q) => q.questionId) }),
      });
      await refetch();
    });

  const alreadyIn = new Set(inSet.map((q) => q.questionId));

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {/* ── in the set ─────────────────────────────────────────────────── */}
      <section className="flex flex-col gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          In this set
          <span className="ml-2 font-normal text-slate-400">{inSet.length}</span>
        </h2>

        {inSet.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-500">
            No questions yet. Add some from the bank on the right.
          </p>
        ) : (
          <ol className="flex flex-col gap-2">
            {inSet.map((row, index) => (
              <li
                key={row.questionId}
                className="flex items-start gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2.5"
              >
                <span className="mt-0.5 w-6 shrink-0 text-xs font-semibold text-slate-400">
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2 text-sm text-slate-800">{row.stem}</p>
                  <p className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-slate-400">
                    <span>{row.difficulty}</span>
                    {row.topic && <span>{row.topic}</span>}
                    <span>{row.optionCount} options</span>
                  </p>
                </div>
                <div className="flex shrink-0 flex-col">
                  <button
                    type="button"
                    aria-label="Move up"
                    disabled={index === 0 || busy}
                    onClick={() => move(index, -1)}
                    className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-30"
                  >
                    <ArrowUp className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    aria-label="Move down"
                    disabled={index === inSet.length - 1 || busy}
                    onClick={() => move(index, 1)}
                    className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-30"
                  >
                    <ArrowDown className="size-3.5" />
                  </button>
                </div>
                <button
                  type="button"
                  aria-label="Remove from set"
                  title="Remove from this set (the question is not deleted)"
                  disabled={busy}
                  onClick={() => detach(row.questionId)}
                  className="mt-0.5 shrink-0 rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                >
                  <X className="size-4" />
                </button>
              </li>
            ))}
          </ol>
        )}
      </section>

      {/* ── add from the bank ──────────────────────────────────────────── */}
      <section className="flex flex-col gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Add from the question bank
        </h2>

        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            search();
          }}
        >
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search the question bank…"
              className={cn(field, "pl-8")}
            />
          </div>
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-slate-900 px-3.5 py-2 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
          >
            Search
          </button>
        </form>

        {error && (
          <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            {error}
          </div>
        )}
        {notice && (
          <div className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-800">
            {notice}
          </div>
        )}

        {results === null ? (
          <p className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-500">
            Search the bank to find questions to add.
          </p>
        ) : results.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-500">
            Nothing matched. Try a different search — every active question is available.
          </p>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <span className="text-xs text-slate-500">{results.length} results</span>
              <button
                type="button"
                disabled={busy || selected.size === 0}
                onClick={() => attach([...selected])}
                className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-700 disabled:opacity-40"
              >
                <Plus className="size-3.5" />
                Add selected ({selected.size})
              </button>
            </div>

            <ul className="flex flex-col gap-1.5">
              {results.map((row) => {
                const present = alreadyIn.has(row.id);
                return (
                  <li
                    key={row.id}
                    className={cn(
                      "flex items-start gap-2 rounded-xl border px-3 py-2",
                      present ? "border-emerald-200 bg-emerald-50/50" : "border-slate-200 bg-white",
                    )}
                  >
                    <input
                      type="checkbox"
                      disabled={present}
                      checked={selected.has(row.id)}
                      onChange={(e) =>
                        setSelected((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(row.id);
                          else next.delete(row.id);
                          return next;
                        })
                      }
                      className="mt-1 size-4"
                      aria-label={present ? "Already in this set" : "Select question"}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="line-clamp-2 text-sm text-slate-800">{row.stem}</p>
                      <p className="mt-0.5 flex gap-x-3 text-[11px] text-slate-400">
                        <span>{row.difficulty}</span>
                        {row.topic && <span>{row.topic}</span>}
                        {present && <span className="text-emerald-600">already in this set</span>}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}
