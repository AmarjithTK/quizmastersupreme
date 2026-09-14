"use client";

/**
 * Question editor (M4) — used for BOTH manual authoring and (from M10) AI
 * candidate review. One component, two entry points, per PLAN.md §9.3.
 *
 * The backstory preview renders through the SAME BackstoryRenderer the quiz
 * runner uses, so a backstory that looks right here looks right to a learner.
 */

import { Eye, Pencil, Plus, X } from "lucide-react";
import { useState } from "react";
import { BackstoryRenderer } from "@/components/backstory/BackstoryRenderer";
import { cn } from "@/lib/utils";

type OptionKey = "A" | "B" | "C" | "D" | "E";

export type QuestionEditorFields = {
  stem: string;
  options: { key: OptionKey; body: string }[];
  correctOptionKey: OptionKey;
  explanation: string;
  backstory: string;
  difficulty: string;
  topic: string;
  tags: string;
  year: string;
  examBody: string;
  source: string;
  sourceUrl: string;
};

export const EMPTY_QUESTION: QuestionEditorFields = {
  stem: "",
  options: [
    { key: "A", body: "" },
    { key: "B", body: "" },
    { key: "C", body: "" },
    { key: "D", body: "" },
  ],
  correctOptionKey: "A",
  explanation: "",
  backstory: "",
  difficulty: "medium",
  topic: "",
  tags: "",
  year: "",
  examBody: "",
  source: "",
  sourceUrl: "",
};

const DIFFICULTIES = ["easy", "medium", "hard", "expert"];
const field =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-900/10";
const labelText = "text-xs font-medium text-slate-600";

/** Form fields → the shape the API expects. */
export function toQuestionPayload(fields: QuestionEditorFields) {
  return {
    stem: fields.stem,
    options: fields.options
      .filter((o) => o.body.trim().length > 0)
      .map((o) => ({ key: o.key, body: o.body })),
    correctOptionKey: fields.correctOptionKey,
    explanation: fields.explanation || null,
    backstory: fields.backstory || null,
    difficulty: fields.difficulty,
    topic: fields.topic || null,
    tags: fields.tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean),
    year: fields.year.trim() === "" ? null : Number(fields.year),
    examBody: fields.examBody || null,
    source: fields.source || null,
    sourceUrl: fields.sourceUrl || null,
  };
}

export function QuestionEditor({
  title,
  initial,
  busy,
  submitLabel,
  error,
  warnings,
  onCancel,
  onSubmit,
}: {
  title: string;
  initial: QuestionEditorFields;
  busy: boolean;
  submitLabel: string;
  error?: string | null;
  warnings?: string[];
  onCancel: () => void;
  onSubmit: (fields: QuestionEditorFields) => void;
}) {
  const [values, setValues] = useState<QuestionEditorFields>(initial);
  const [preview, setPreview] = useState(false);

  const hasFifth = values.options.some((o) => o.key === "E");
  const visibleOptions = hasFifth ? values.options : values.options.filter((o) => o.key !== "E");

  const setOption = (key: OptionKey, body: string) =>
    setValues((v) => ({
      ...v,
      options: v.options.map((o) => (o.key === key ? { ...o, body } : o)),
    }));

  const addFifth = () =>
    setValues((v) => ({
      ...v,
      options: [...v.options.filter((o) => o.key !== "E"), { key: "E" as OptionKey, body: "" }],
    }));

  const removeFifth = () =>
    setValues((v) => ({
      ...v,
      options: v.options.filter((o) => o.key !== "E"),
      // Never leave "correct" pointing at an option that no longer exists.
      correctOptionKey: v.correctOptionKey === "E" ? "A" : v.correctOptionKey,
    }));

  return (
    <form
      className="flex flex-col gap-4 rounded-xl border border-slate-200 bg-slate-50 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (values.stem.trim()) onSubmit(values);
      }}
    >
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
        <button
          type="button"
          onClick={onCancel}
          aria-label="Close"
          className="rounded p-1 text-slate-400 hover:bg-slate-200"
        >
          <X className="size-4" />
        </button>
      </div>

      {error && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </div>
      )}
      {warnings && warnings.length > 0 && (
        <ul className="flex flex-col gap-1 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {warnings.map((w) => (
            <li key={w}>⚠ {w}</li>
          ))}
        </ul>
      )}

      <label className="flex flex-col gap-1">
        <span className={labelText}>Question *</span>
        <textarea
          required
          rows={3}
          value={values.stem}
          onChange={(e) => setValues((v) => ({ ...v, stem: e.target.value }))}
          className={field}
          placeholder="Which data structure processes elements in first-in, first-out order?"
        />
      </label>

      {/* ── options ─────────────────────────────────────────────────────── */}
      <fieldset className="flex flex-col gap-2">
        <legend className={cn(labelText, "mb-1")}>
          Options — select the correct one *
        </legend>
        {visibleOptions.map((option) => (
          <div key={option.key} className="flex items-center gap-2">
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="correctOption"
                checked={values.correctOptionKey === option.key}
                onChange={() => setValues((v) => ({ ...v, correctOptionKey: option.key }))}
                className="size-4"
                aria-label={`Option ${option.key} is correct`}
              />
              <span className="w-4 text-xs font-semibold text-slate-500">{option.key}</span>
            </label>
            <input
              value={option.body}
              onChange={(e) => setOption(option.key, e.target.value)}
              className={field}
              placeholder={`Option ${option.key}`}
            />
            {option.key === "E" && (
              <button
                type="button"
                onClick={removeFifth}
                aria-label="Remove option E"
                className="rounded p-1.5 text-slate-400 hover:bg-slate-200"
              >
                <X className="size-4" />
              </button>
            )}
          </div>
        ))}
        {!hasFifth && (
          <button
            type="button"
            onClick={addFifth}
            className="inline-flex items-center gap-1.5 self-start rounded-lg px-2 py-1 text-xs font-medium text-slate-500 hover:bg-slate-200"
          >
            <Plus className="size-3.5" />
            Add a fifth option
          </button>
        )}
      </fieldset>

      <label className="flex flex-col gap-1">
        <span className={labelText}>Short explanation</span>
        <textarea
          rows={2}
          value={values.explanation}
          onChange={(e) => setValues((v) => ({ ...v, explanation: e.target.value }))}
          className={field}
          placeholder="One or two sentences on why the answer is right."
        />
      </label>

      {/* ── backstory ───────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <span className={labelText}>Backstory (markdown)</span>
          <button
            type="button"
            onClick={() => setPreview((p) => !p)}
            className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium text-slate-500 hover:bg-slate-200"
          >
            {preview ? <Pencil className="size-3.5" /> : <Eye className="size-3.5" />}
            {preview ? "Edit" : "Preview"}
          </button>
        </div>

        {preview ? (
          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <BackstoryRenderer content={values.backstory} />
          </div>
        ) : (
          <textarea
            rows={8}
            value={values.backstory}
            onChange={(e) => setValues((v) => ({ ...v, backstory: e.target.value }))}
            className={cn(field, "font-mono text-[13px]")}
            placeholder={"### Why this matters\n\nContext, history or a memorable fact.\n\n| Year | Milestone |\n|------|-----------|\n| 1964 | ... |"}
          />
        )}
      </div>

      {/* ── metadata ────────────────────────────────────────────────────── */}
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1">
          <span className={labelText}>Difficulty</span>
          <select
            value={values.difficulty}
            onChange={(e) => setValues((v) => ({ ...v, difficulty: e.target.value }))}
            className={field}
          >
            {DIFFICULTIES.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelText}>Topic</span>
          <input
            value={values.topic}
            onChange={(e) => setValues((v) => ({ ...v, topic: e.target.value }))}
            className={field}
            placeholder="Operating Systems"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelText}>Year</span>
          <input
            value={values.year}
            onChange={(e) => setValues((v) => ({ ...v, year: e.target.value }))}
            inputMode="numeric"
            className={field}
            placeholder="2025"
          />
        </label>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className={labelText}>Tags (comma separated)</span>
          <input
            value={values.tags}
            onChange={(e) => setValues((v) => ({ ...v, tags: e.target.value }))}
            className={field}
            placeholder="linux, history"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelText}>Exam body</span>
          <input
            value={values.examBody}
            onChange={(e) => setValues((v) => ({ ...v, examBody: e.target.value }))}
            className={field}
            placeholder="Kerala PSC"
          />
        </label>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className={labelText}>Source</span>
          <input
            value={values.source}
            onChange={(e) => setValues((v) => ({ ...v, source: e.target.value }))}
            className={field}
            placeholder="Standard OS textbooks"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelText}>Source URL</span>
          <input
            value={values.sourceUrl}
            onChange={(e) => setValues((v) => ({ ...v, sourceUrl: e.target.value }))}
            className={field}
            placeholder="https://…"
          />
        </label>
      </div>

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy || !values.stem.trim()}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {busy ? "Saving…" : submitLabel}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-200"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
