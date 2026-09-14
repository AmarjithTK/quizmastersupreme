"use client";

/**
 * Category management (M2): create, edit, reorder, publish and archive
 * subjects. Every mutation goes through /api/admin/categories which enforces
 * the admin role server-side — this component is never the security boundary.
 */

import { ArrowDown, ArrowUp, Pencil, Plus, Trash2, X } from "lucide-react";
import { useState, useTransition } from "react";
import { cn } from "@/lib/utils";

type CategoryRow = {
  id: string;
  slug: string;
  title: string;
  subtitle: string | null;
  description: string | null;
  icon: string | null;
  accentColor: string | null;
  sortOrder: number;
  status: "draft" | "published" | "archived";
  setCount: number;
};

type Fields = {
  title: string;
  slug: string;
  subtitle: string;
  description: string;
  icon: string;
  accentColor: string;
};

const EMPTY_FIELDS: Fields = { title: "", slug: "", subtitle: "", description: "", icon: "", accentColor: "" };

const ICONS = ["Atom", "BookOpen", "Brain", "Briefcase", "Calculator", "Cpu", "Dna", "FlaskConical", "Globe", "IndianRupee", "Landmark", "Languages", "Microscope", "Sigma", "Stethoscope", "Trophy"];
const ACCENTS = ["sky", "violet", "emerald", "amber", "rose", "teal", "lime", "orange", "indigo", "cyan"];

export function CategoryManager({ initial }: { initial: CategoryRow[] }) {
  const [items, setItems] = useState<CategoryRow[]>(initial);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [create, setCreate] = useState(false);
  const [busy, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  async function api(path: string, init?: RequestInit): Promise<{ category?: CategoryRow; categories?: CategoryRow[]; error?: { message: string } }> {
    const res = await fetch(path, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
    const body = (await res.json().catch(() => ({}))) as { category?: CategoryRow; categories?: CategoryRow[]; error?: { message: string } };
    if (!res.ok) throw new Error(body.error?.message ?? "Request failed");
    return body;
  }

  async function refetch() {
    const data = await api("/api/admin/categories");
    if (data.categories) setItems(data.categories);
  }

  async function run(action: () => Promise<void>) {
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

  const submitCreate = (fields: Fields) =>
    run(async () => {
      await api("/api/admin/categories", {
        method: "POST",
        body: JSON.stringify({ ...fields, slug: fields.slug || undefined }),
      });
      setCreate(false);
      await refetch();
    });

  const submitEdit = (row: CategoryRow, fields: Fields) =>
    run(async () => {
      await api(`/api/admin/categories/${row.id}`, {
        method: "PATCH",
        body: JSON.stringify({ ...fields, slug: fields.slug || undefined }),
      });
      setEditingId(null);
      await refetch();
    });

  const toggleStatus = (row: CategoryRow) =>
    run(async () => {
      await api(`/api/admin/categories/${row.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: row.status === "published" ? "draft" : "published" }),
      });
      await refetch();
    });

  const move = (index: number, delta: -1 | 1) =>
    run(async () => {
      const next = [...items];
      const target = index + delta;
      if (target < 0 || target >= next.length) return;
      const a = next[index]!;
      const b = next[target]!;
      next[index] = b;
      next[target] = a;
      await api("/api/admin/categories/reorder", {
        method: "POST",
        body: JSON.stringify({ orderedIds: next.map((c) => c.id) }),
      });
      await refetch();
    });

  const archive = (row: CategoryRow) =>
    run(async () => {
      if (!window.confirm(`Archive "${row.title}"? It will disappear from the home screen but its data is kept.`)) return;
      await api(`/api/admin/categories/${row.id}`, { method: "DELETE" });
      await refetch();
    });

  // ── render ─────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </div>
      )}

      {create ? (
        <CategoryForm
          title="New subject"
          fields={EMPTY_FIELDS}
          busy={busy}
          submitLabel="Create"
          onCancel={() => setCreate(false)}
          onSubmit={submitCreate}
        />
      ) : (
        <button
          type="button"
          onClick={() => setCreate(true)}
          className="inline-flex items-center gap-2 self-start rounded-xl border border-dashed border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 hover:border-slate-400 hover:bg-white"
        >
          <Plus className="size-4" />
          Add subject
        </button>
      )}

      <ul className="flex flex-col gap-2">
        {items.map((row, index) =>
          editingId === row.id ? (
            <li key={row.id}>
              <CategoryForm
                title={`Edit — ${row.title}`}
                fields={{
                  title: row.title,
                  slug: row.slug,
                  subtitle: row.subtitle ?? "",
                  description: row.description ?? "",
                  icon: row.icon ?? "",
                  accentColor: row.accentColor ?? "",
                }}
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
                  onClick={() => move(index, -1)}
                  className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-30"
                >
                  <ArrowUp className="size-3.5" />
                </button>
                <button
                  type="button"
                  aria-label="Move down"
                  disabled={index === items.length - 1 || busy}
                  onClick={() => move(index, 1)}
                  className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-30"
                >
                  <ArrowDown className="size-3.5" />
                </button>
              </div>

              <span
                className={cn(
                  "size-8 shrink-0 rounded-lg",
                  row.icon ? "bg-slate-100" : "bg-slate-50",
                )}
                aria-hidden
              >
                {row.icon && (
                  <span className="flex size-8 items-center justify-center text-xs font-semibold text-slate-500">
                    {row.icon === "Atom" ? "⚛" : row.icon === "Cpu" ? "💻" : "◈"}
                  </span>
                )}
              </span>

              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-semibold text-slate-900">{row.title}</span>
                  <StatusBadge status={row.status} />
                </div>
                <p className="truncate text-xs text-slate-500">
                  /{row.slug}
                  {row.setCount > 0 && <> · {row.setCount} {row.setCount === 1 ? "set" : "sets"}</>}
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
                <IconButton label="Edit" onClick={() => setEditingId(row.id)}>
                  <Pencil className="size-4" />
                </IconButton>
                <IconButton
                  label="Archive"
                  onClick={() => archive(row)}
                  className="text-slate-400 hover:bg-red-50 hover:text-red-600"
                >
                  <Trash2 className="size-4" />
                </IconButton>
              </div>
            </li>
          ),
        )}
      </ul>
    </div>
  );
}

function StatusBadge({ status }: { status: CategoryRow["status"] }) {
  const styles = {
    published: "bg-emerald-50 text-emerald-700",
    draft: "bg-amber-50 text-amber-700",
    archived: "bg-slate-100 text-slate-500",
  } as const;
  return (
    <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide", styles[status])}>
      {status}
    </span>
  );
}

function IconButton({
  label,
  onClick,
  className,
  children,
}: {
  label: string;
  onClick: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn("rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700", className)}
    >
      {children}
    </button>
  );
}

// ── form ─────────────────────────────────────────────────────────────────────

const field = "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-900/10";

function CategoryForm({
  title,
  fields,
  busy,
  submitLabel,
  onCancel,
  onSubmit,
}: {
  title: string;
  fields: Fields;
  busy: boolean;
  submitLabel: string;
  onCancel: () => void;
  onSubmit: (fields: Fields) => void;
}) {
  const [values, setValues] = useState<Fields>(fields);
  const set = (key: keyof Fields) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setValues((v) => ({ ...v, [key]: e.target.value }));

  return (
    <form
      className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (values.title.trim()) onSubmit(values);
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
          Title *
          <input required value={values.title} onChange={set("title")} className={field} placeholder="Biology" />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          Slug (URL)
          <input value={values.slug} onChange={set("slug")} className={field} placeholder="auto from title" />
        </label>
      </div>

      <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
        Subtitle
        <input value={values.subtitle} onChange={set("subtitle")} className={field} placeholder="Life sciences" />
      </label>

      <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
        Description
        <textarea value={values.description} onChange={set("description")} rows={2} className={field} placeholder="Optional description shown on the category page" />
      </label>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          Icon
          <select value={values.icon} onChange={set("icon")} className={field}>
            <option value="">Default</option>
            {ICONS.map((icon) => (
              <option key={icon} value={icon}>{icon}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          Accent colour
          <select value={values.accentColor} onChange={set("accentColor")} className={field}>
            <option value="">Default</option>
            {ACCENTS.map((accent) => (
              <option key={accent} value={accent}>{accent}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy || !values.title.trim()}
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