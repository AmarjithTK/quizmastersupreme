"use client";

/**
 * Quiz set management (M3): create, edit, publish, archive and reorder sets.
 *
 * Sets are grouped by their parent subject, and the list is filterable to one
 * subject. Every mutation goes through /api/admin/sets, which enforces the
 * admin role server-side — this component is never the security boundary.
 *
 * Time limits are entered in MINUTES and stored in SECONDS; the conversion is
 * confined to toPayload/fromRow so nothing else has to remember the unit.
 */

import { ArrowDown, ArrowUp, Pencil, Plus, Trash2, X } from "lucide-react";
import { useMemo, useState, useTransition } from "react";
import { cn, formatDuration } from "@/lib/utils";

type SetRow = {
  id: string;
  categoryId: string;
  categoryTitle: string;
  slug: string;
  title: string;
  description: string | null;
  groupLabel: string | null;
  mode: "practice" | "mock";
  difficulty: string;
  timeLimitSeconds: number | null;
  questionLimit: number | null;
  shuffleQuestions: number;
  shuffleOptions: number;
  passingPercent: number | null;
  sortOrder: number;
  status: "draft" | "published" | "archived";
  questionCount: number;
};

type CategoryOption = { id: string; title: string; status: string };

type SetFields = {
  categoryId: string;
  title: string;
  slug: string;
  groupLabel: string;
  description: string;
  mode: "practice" | "mock";
  difficulty: string;
  timeLimitMinutes: string;
  questionLimit: string;
  passingPercent: string;
  shuffleQuestions: boolean;
  shuffleOptions: boolean;
};

const DIFFICULTIES = ["easy", "medium", "hard", "expert", "mixed"];
const field =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-900/10";

function emptyFields(categoryId: string): SetFields {
  return {
    categoryId,
    title: "",
    slug: "",
    groupLabel: "",
    description: "",
    mode: "practice",
    difficulty: "medium",
    timeLimitMinutes: "",
    questionLimit: "",
    passingPercent: "",
    shuffleQuestions: true,
    shuffleOptions: false,
  };
}

function fromRow(row: SetRow): SetFields {
  return {
    categoryId: row.categoryId,
    title: row.title,
    slug: row.slug,
    groupLabel: row.groupLabel ?? "",
    description: row.description ?? "",
    mode: row.mode,
    difficulty: row.difficulty,
    timeLimitMinutes: row.timeLimitSeconds ? String(Math.round(row.timeLimitSeconds / 60)) : "",
    questionLimit: row.questionLimit ? String(row.questionLimit) : "",
    passingPercent: row.passingPercent != null ? String(row.passingPercent) : "",
    shuffleQuestions: row.shuffleQuestions === 1,
    shuffleOptions: row.shuffleOptions === 1,
  };
}

/** Minutes in the form, seconds in the database. */
function toPayload(fields: SetFields) {
  const minutes = fields.timeLimitMinutes.trim();
  const limit = fields.questionLimit.trim();
  const passing = fields.passingPercent.trim();
  return {
    categoryId: fields.categoryId,
    title: fields.title,
    slug: fields.slug.trim() || undefined,
    groupLabel: fields.groupLabel.trim() || null,
    description: fields.description.trim() || null,
    mode: fields.mode,
    difficulty: fields.difficulty,
    timeLimitSeconds: minutes ? Math.round(Number(minutes) * 60) : null,
    questionLimit: limit ? Number(limit) : null,
    passingPercent: passing ? Number(passing) : null,
    shuffleQuestions: fields.shuffleQuestions,
    shuffleOptions: fields.shuffleOptions,
  };
}

export function SetManager({
  initialSets,
  categories,
}: {
  initialSets: SetRow[];
  categories: CategoryOption[];
}) {
  const [sets, setSets] = useState<SetRow[]>(initialSets);
  const [filter, setFilter] = useState<string>("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const visible = useMemo(
    () => (filter ? sets.filter((s) => s.categoryId === filter) : sets),
    [sets, filter],
  );

  /** Group by subject, preserving the server's ordering. */
  const groups = useMemo(() => {
    const map = new Map<string, { title: string; rows: SetRow[] }>();
    for (const row of visible) {
      if (!map.has(row.categoryId)) map.set(row.categoryId, { title: row.categoryTitle, rows: [] });
      map.get(row.categoryId)!.rows.push(row);
    }
    return [...map.entries()].map(([id, value]) => ({ id, ...value }));
  }, [visible]);

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
    const data = await api<{ sets: SetRow[] }>("/api/admin/sets");
    setSets(data.sets);
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

  const submitCreate = (fields: SetFields) =>
    run(async () => {
      await api("/api/admin/sets", { method: "POST", body: JSON.stringify(toPayload(fields)) });
      setCreating(false);
      await refetch();
    });

  const submitEdit = (row: SetRow, fields: SetFields) =>
    run(async () => {
      const { categoryId: _ignored, ...patch } = toPayload(fields);
      await api(`/api/admin/sets/${row.id}`, { method: "PATCH", body: JSON.stringify(patch) });
      setEditingId(null);
      await refetch();
    });

  const toggleStatus = (row: SetRow) =>
    run(async () => {
      await api(`/api/admin/sets/${row.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: row.status === "published" ? "draft" : "published" }),
      });
      await refetch();
    });

  const archive = (row: SetRow) =>
    run(async () => {
      if (!window.confirm(`Archive "${row.title}"? Attempts already taken are kept.`)) return;
      await api(`/api/admin/sets/${row.id}`, { method: "DELETE" });
      await refetch();
    });

  /** Reorder within the visible group (the server just writes sortOrder). */
  const move = (group: SetRow[], index: number, delta: -1 | 1) =>
    run(async () => {
      const target = index + delta;
      if (target < 0 || target >= group.length) return;
      const next = [...group];
      const a = next[index]!;
      next[index] = next[target]!;
      next[target] = a;
      await api("/api/admin/sets/reorder", {
        method: "POST",
        body: JSON.stringify({ orderedIds: next.map((s) => s.id) }),
      });
      await refetch();
    });

  const hasCategories = categories.length > 0;
  const defaultCategory = filter || categories[0]?.id || "";

  // ── render ─────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </div>
      )}

      {!hasCategories ? (
        <p className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
          Create a subject first — every quiz set lives inside one.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {creating ? (
              <span className="text-sm text-slate-500">Filling in the new set below…</span>
            ) : (
              <button
                type="button"
                onClick={() => setCreating(true)}
                className="inline-flex items-center gap-2 rounded-xl border border-dashed border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 hover:border-slate-400 hover:bg-white"
              >
                <Plus className="size-4" />
                Add set
              </button>
            )}

            <label className="ml-auto flex items-center gap-2 text-xs font-medium text-slate-500">
              Subject
              <select value={filter} onChange={(e) => setFilter(e.target.value)} className={cn(field, "w-48")}>
                <option value="">All subjects</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {creating && (
            <SetForm
              title="New quiz set"
              fields={emptyFields(defaultCategory)}
              categories={categories}
              busy={busy}
              submitLabel="Create"
              onCancel={() => setCreating(false)}
              onSubmit={submitCreate}
            />
          )}

          {groups.length === 0 && !creating && (
            <p className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
              No quiz sets here yet.
            </p>
          )}

          {groups.map((group) => (
            <section key={group.id} className="flex flex-col gap-2">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                {group.title}
                <span className="ml-2 font-normal text-slate-400">{group.rows.length}</span>
              </h2>

              <ul className="flex flex-col gap-2">
                {group.rows.map((row, index) =>
                  editingId === row.id ? (
                    <li key={row.id}>
                      <SetForm
                        title={`Edit — ${row.title}`}
                        fields={fromRow(row)}
                        categories={categories}
                        busy={busy}
                        submitLabel="Save"
                        onCancel={() => setEditingId(null)}
                        onSubmit={(fields) => submitEdit(row, fields)}
                      />
                    </li>
                  ) : (
                    <li
                      key={row.id}
                      className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2.5"
                    >
                      <div className="flex flex-col">
                        <button
                          type="button"
                          aria-label="Move up"
                          disabled={index === 0 || busy}
                          onClick={() => move(group.rows, index, -1)}
                          className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-30"
                        >
                          <ArrowUp className="size-3.5" />
                        </button>
                        <button
                          type="button"
                          aria-label="Move down"
                          disabled={index === group.rows.length - 1 || busy}
                          onClick={() => move(group.rows, index, 1)}
                          className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-30"
                        >
                          <ArrowDown className="size-3.5" />
                        </button>
                      </div>

                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="truncate text-sm font-semibold text-slate-900">{row.title}</span>
                          <StatusBadge status={row.status} />
                          {row.groupLabel && (
                            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">
                              {row.groupLabel}
                            </span>
                          )}
                        </div>
                        <p className="truncate text-xs text-slate-500">
                          /{row.slug} · {row.questionCount}{" "}
                          {row.questionCount === 1 ? "question" : "questions"}
                          {formatDuration(row.timeLimitSeconds) && <> · {formatDuration(row.timeLimitSeconds)}</>}
                          {" · "}
                          {row.mode}
                          {" · "}
                          {row.difficulty}
                        </p>
                      </div>

                      <div className="flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          onClick={() => toggleStatus(row)}
                          disabled={busy}
                          className={cn(
                            "rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-colors",
                            row.status === "published"
                              ? "bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                              : "bg-slate-100 text-slate-600 hover:bg-slate-200",
                          )}
                        >
                          {row.status === "published" ? "Published" : "Publish"}
                        </button>
                        <button
                          type="button"
                          aria-label="Edit"
                          title="Edit"
                          onClick={() => setEditingId(row.id)}
                          className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                        >
                          <Pencil className="size-4" />
                        </button>
                        <button
                          type="button"
                          aria-label="Archive"
                          title="Archive"
                          onClick={() => archive(row)}
                          className="rounded-lg p-2 text-slate-400 hover:bg-red-50 hover:text-red-600"
                        >
                          <Trash2 className="size-4" />
                        </button>
                      </div>
                    </li>
                  ),
                )}
              </ul>
            </section>
          ))}
        </>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: SetRow["status"] }) {
  const styles = {
    published: "bg-emerald-50 text-emerald-700",
    draft: "bg-amber-50 text-amber-700",
    archived: "bg-slate-100 text-slate-500",
  } as const;
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
        styles[status],
      )}
    >
      {status}
    </span>
  );
}

function SetForm({
  title,
  fields,
  categories,
  busy,
  submitLabel,
  onCancel,
  onSubmit,
}: {
  title: string;
  fields: SetFields;
  categories: CategoryOption[];
  busy: boolean;
  submitLabel: string;
  onCancel: () => void;
  onSubmit: (fields: SetFields) => void;
}) {
  const [values, setValues] = useState<SetFields>(fields);
  const set =
    (key: keyof SetFields) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setValues((v) => ({ ...v, [key]: e.target.value }));

  return (
    <form
      className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (values.title.trim() && values.categoryId) onSubmit(values);
      }}
    >
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
        <button type="button" onClick={onCancel} aria-label="Close" className="rounded p-1 text-slate-400 hover:bg-slate-200">
          <X className="size-4" />
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          Subject *
          <select required value={values.categoryId} onChange={set("categoryId")} className={field}>
            <option value="">Choose…</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          Title *
          <input required value={values.title} onChange={set("title")} className={field} placeholder="Kerala State Mock Set 1" />
        </label>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          Slug (URL)
          <input value={values.slug} onChange={set("slug")} className={field} placeholder="auto from title" />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          Group label
          <input value={values.groupLabel} onChange={set("groupLabel")} className={field} placeholder="Kerala State" />
          <span className="font-normal text-slate-400">Display-only heading on the subject page.</span>
        </label>
      </div>

      <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
        Description
        <textarea value={values.description} onChange={set("description")} rows={2} className={field} />
      </label>

      <div className="grid gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          Mode
          <select value={values.mode} onChange={set("mode")} className={field}>
            <option value="practice">Practice</option>
            <option value="mock">Mock</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          Difficulty
          <select value={values.difficulty} onChange={set("difficulty")} className={field}>
            {DIFFICULTIES.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          Time limit (minutes)
          <input value={values.timeLimitMinutes} onChange={set("timeLimitMinutes")} inputMode="numeric" className={field} placeholder="untimed" />
        </label>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          Question limit
          <input value={values.questionLimit} onChange={set("questionLimit")} inputMode="numeric" className={field} placeholder="all questions" />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          Passing percentage
          <input value={values.passingPercent} onChange={set("passingPercent")} inputMode="numeric" className={field} placeholder="none" />
        </label>
      </div>

      <div className="flex flex-wrap gap-4">
        <label className="flex items-center gap-2 text-xs font-medium text-slate-600">
          <input
            type="checkbox"
            checked={values.shuffleQuestions}
            onChange={(e) => setValues((v) => ({ ...v, shuffleQuestions: e.target.checked }))}
            className="size-4 rounded border-slate-300"
          />
          Shuffle questions
        </label>
        <label className="flex items-center gap-2 text-xs font-medium text-slate-600">
          <input
            type="checkbox"
            checked={values.shuffleOptions}
            onChange={(e) => setValues((v) => ({ ...v, shuffleOptions: e.target.checked }))}
            className="size-4 rounded border-slate-300"
          />
          Shuffle options
        </label>
      </div>

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy || !values.title.trim() || !values.categoryId}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {busy ? "Saving…" : submitLabel}
        </button>
        <button type="button" onClick={onCancel} className="rounded-lg px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-200">
          Cancel
        </button>
      </div>
    </form>
  );
}
