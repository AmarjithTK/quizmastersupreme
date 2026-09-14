"use client";

/**
 * Question bank (M4): search, filter, author, and move questions through the
 * status flow.
 *
 * Search runs against D1's FTS5 index server-side, so the browser never holds
 * the whole bank. Filters and pagination are query params on
 * /api/admin/questions.
 */

import { Archive, FileText, Pencil, Plus, Search, CheckCircle2 } from "lucide-react";
import { useState, useTransition } from "react";
import {
  EMPTY_QUESTION,
  QuestionEditor,
  toQuestionPayload,
  type QuestionEditorFields,
} from "@/components/admin/QuestionEditor";
import { cn } from "@/lib/utils";

type QuestionRow = {
  id: string;
  stem: string;
  difficulty: string;
  topic: string | null;
  status: string;
  origin: string;
  year: number | null;
  examBody: string | null;
  hasBackstory: boolean;
  optionCount: number;
  setCount: number;
  createdAt: number;
};

const STATUSES = ["draft", "review", "approved", "published", "archived", "rejected"];
const DIFFICULTIES = ["easy", "medium", "hard", "expert"];
const PAGE_SIZE = 20;

const field =
  "rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-900/10";

export function QuestionBank({ initial }: { initial: { rows: QuestionRow[]; total: number } }) {
  const [rows, setRows] = useState<QuestionRow[]>(initial.rows);
  const [total, setTotal] = useState(initial.total);
  const [page, setPage] = useState(1);

  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [difficulty, setDifficulty] = useState("");

  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingFields, setEditingFields] = useState<QuestionEditorFields | null>(null);

  const [busy, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  async function api<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(path, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
    const body = (await res.json().catch(() => ({}))) as {
      error?: { message: string; details?: Array<{ message: string }> };
    };
    if (!res.ok) {
      // Validation errors come back as a details array; surface the first one
      // but keep the rest visible below the form.
      const detail = body.error?.details?.[0]?.message;
      throw new Error(detail ? `${body.error?.message} ${detail}` : (body.error?.message ?? "Request failed"));
    }
    return body as T;
  }

  async function load(nextPage = page) {
    const params = new URLSearchParams();
    if (query.trim()) params.set("q", query.trim());
    if (status) params.set("status", status);
    if (difficulty) params.set("difficulty", difficulty);
    params.set("page", String(nextPage));
    params.set("pageSize", String(PAGE_SIZE));

    const data = await api<{ rows: QuestionRow[]; total: number }>(
      `/api/admin/questions?${params.toString()}`,
    );
    setRows(data.rows);
    setTotal(data.total);
    setPage(nextPage);
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

  // ── actions ────────────────────────────────────────────────────────────

  const submitCreate = (fields: QuestionEditorFields) =>
    run(async () => {
      const res = await api<{ warnings: Array<{ message: string }> }>("/api/admin/questions", {
        method: "POST",
        body: JSON.stringify(toQuestionPayload(fields)),
      });
      setWarnings((res.warnings ?? []).map((w) => w.message));
      setCreating(false);
      await load(1);
    });

  const submitEdit = (id: string, fields: QuestionEditorFields) =>
    run(async () => {
      const res = await api<{ warnings: Array<{ message: string }> }>(`/api/admin/questions/${id}`, {
        method: "PATCH",
        body: JSON.stringify(toQuestionPayload(fields)),
      });
      setWarnings((res.warnings ?? []).map((w) => w.message));
      setEditingId(null);
      setEditingFields(null);
      await load();
    });

  const openEditor = (row: QuestionRow) =>
    run(async () => {
      const data = await api<{
        question: {
          stem: string;
          explanation: string | null;
          backstory: string | null;
          difficulty: string;
          topic: string | null;
          tags: string | null;
          year: number | null;
          examBody: string | null;
          source: string | null;
          sourceUrl: string | null;
          options: Array<{ key: string; body: string; isCorrect: number }>;
        };
      }>(`/api/admin/questions/${row.id}`);

      const q = data.question;
      const correct = q.options.find((o) => o.isCorrect === 1)?.key ?? "A";
      setEditingFields({
        stem: q.stem,
        options: q.options.map((o) => ({ key: o.key as "A" | "B" | "C" | "D" | "E", body: o.body })),
        correctOptionKey: correct as "A" | "B" | "C" | "D" | "E",
        explanation: q.explanation ?? "",
        backstory: q.backstory ?? "",
        difficulty: q.difficulty,
        topic: q.topic ?? "",
        tags: q.tags ? (JSON.parse(q.tags) as string[]).join(", ") : "",
        year: q.year != null ? String(q.year) : "",
        examBody: q.examBody ?? "",
        source: q.source ?? "",
        sourceUrl: q.sourceUrl ?? "",
      });
      setEditingId(row.id);
    });

  const setQuestionStatus = (row: QuestionRow, next: string) =>
    run(async () => {
      await api(`/api/admin/questions/${row.id}/status`, {
        method: "POST",
        body: JSON.stringify({ status: next }),
      });
      await load();
    });

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // ── render ─────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </div>
      )}

      {creating ? (
        <QuestionEditor
          title="New question"
          initial={EMPTY_QUESTION}
          busy={busy}
          submitLabel="Create"
          warnings={warnings}
          onCancel={() => setCreating(false)}
          onSubmit={submitCreate}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setWarnings([]);
              setCreating(true);
            }}
            className="inline-flex items-center gap-2 rounded-xl border border-dashed border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 hover:border-slate-400 hover:bg-white"
          >
            <Plus className="size-4" />
            New question
          </button>

          <form
            className="ml-auto flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              run(() => load(1));
            }}
          >
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search question text…"
                className={cn(field, "w-56 pl-8")}
              />
            </div>
            <select value={status} onChange={(e) => setStatus(e.target.value)} className={field}>
              <option value="">Any status</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <select value={difficulty} onChange={(e) => setDifficulty(e.target.value)} className={field}>
              <option value="">Any difficulty</option>
              {DIFFICULTIES.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
            <button
              type="submit"
              disabled={busy}
              className="rounded-lg bg-slate-900 px-3.5 py-2 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
            >
              Search
            </button>
          </form>
        </div>
      )}

      <p className="text-xs text-slate-500">
        {total} {total === 1 ? "question" : "questions"}
        {query.trim() && <> matching “{query.trim()}”</>}
      </p>

      <ul className="flex flex-col gap-2">
        {rows.map((row) =>
          editingId === row.id && editingFields ? (
            <li key={row.id}>
              <QuestionEditor
                title={`Edit — ${row.stem.slice(0, 60)}…`}
                initial={editingFields}
                busy={busy}
                submitLabel="Save"
                warnings={warnings}
                onCancel={() => {
                  setEditingId(null);
                  setEditingFields(null);
                }}
                onSubmit={(fields) => submitEdit(row.id, fields)}
              />
            </li>
          ) : (
            <li key={row.id} className="flex items-start gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge status={row.status} />
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">
                    {row.difficulty}
                  </span>
                  {row.topic && (
                    <span className="text-[11px] text-slate-500">{row.topic}</span>
                  )}
                  {row.year && <span className="text-[11px] text-slate-400">{row.year}</span>}
                </div>
                <p className="mt-1 line-clamp-2 text-sm text-slate-800">{row.stem}</p>
                <p className="mt-1 flex flex-wrap items-center gap-x-3 text-[11px] text-slate-400">
                  <span>{row.optionCount} options</span>
                  <span>
                    in {row.setCount} {row.setCount === 1 ? "set" : "sets"}
                  </span>
                  {!row.hasBackstory && (
                    <span className="inline-flex items-center gap-1 text-amber-600">
                      <FileText className="size-3" />
                      no backstory
                    </span>
                  )}
                  <span className="text-slate-300">{row.origin}</span>
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-1">
                {row.status !== "published" && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setQuestionStatus(row, "published")}
                    className="inline-flex items-center gap-1 rounded-lg bg-emerald-50 px-2.5 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
                  >
                    <CheckCircle2 className="size-3.5" />
                    Publish
                  </button>
                )}
                {row.status === "draft" && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setQuestionStatus(row, "review")}
                    className="rounded-lg bg-slate-100 px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-200 disabled:opacity-50"
                  >
                    Send to review
                  </button>
                )}
                <button
                  type="button"
                  aria-label="Edit"
                  title="Edit"
                  onClick={() => openEditor(row)}
                  className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                >
                  <Pencil className="size-4" />
                </button>
                <button
                  type="button"
                  aria-label="Archive"
                  title="Archive"
                  disabled={busy}
                  onClick={() => setQuestionStatus(row, "archived")}
                  className="rounded-lg p-2 text-slate-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                >
                  <Archive className="size-4" />
                </button>
              </div>
            </li>
          ),
        )}
      </ul>

      {rows.length === 0 && !creating && (
        <p className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
          No questions match. Try a different search, or author the first one.
        </p>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <button
            type="button"
            disabled={page <= 1 || busy}
            onClick={() => run(() => load(page - 1))}
            className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-40"
          >
            ← Previous
          </button>
          <span className="text-xs text-slate-500">
            Page {page} of {totalPages}
          </span>
          <button
            type="button"
            disabled={page >= totalPages || busy}
            onClick={() => run(() => load(page + 1))}
            className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-40"
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    published: "bg-emerald-50 text-emerald-700",
    approved: "bg-sky-50 text-sky-700",
    review: "bg-amber-50 text-amber-700",
    draft: "bg-slate-100 text-slate-600",
    archived: "bg-slate-100 text-slate-400",
    rejected: "bg-red-50 text-red-700",
    duplicate: "bg-red-50 text-red-700",
    ai_draft: "bg-violet-50 text-violet-700",
  };
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
        styles[status] ?? "bg-slate-100 text-slate-600",
      )}
    >
      {status.replace("_", " ")}
    </span>
  );
}
