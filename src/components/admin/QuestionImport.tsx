"use client";

/**
 * CSV import panel (M9).
 *
 * Two-step on purpose: a DRY RUN validates and reports without writing, so an
 * admin can see exactly what a file would do before committing it. The report
 * lists every row — created, duplicate, duplicate-within-the-file, or invalid
 * with reasons — because silently dropping rows is how a question bank quietly
 * loses content.
 */

import { AlertCircle, CheckCircle2, Copy, FileUp, Upload, X } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

type ImportRowResult = {
  row: number;
  status: "created" | "duplicate" | "duplicate_in_file" | "invalid";
  stem: string;
  questionId?: string;
  matchedStem?: string;
  reasons?: string[];
};

type ImportReport = {
  total: number;
  created: number;
  duplicates: number;
  invalid: number;
  dryRun: boolean;
  results: ImportRowResult[];
};

const STATUS_LABEL: Record<ImportRowResult["status"], string> = {
  created: "created",
  duplicate: "duplicate",
  duplicate_in_file: "duplicate in file",
  invalid: "invalid",
};

const STATUS_TONE: Record<ImportRowResult["status"], string> = {
  created: "bg-emerald-50 text-emerald-700",
  duplicate: "bg-amber-50 text-amber-700",
  duplicate_in_file: "bg-amber-50 text-amber-700",
  invalid: "bg-red-50 text-red-700",
};

export function QuestionImport({
  onImported,
  onClose,
}: {
  onImported: () => void;
  onClose: () => void;
}) {
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [status, setStatus] = useState("active");
  const [report, setReport] = useState<ImportReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(dryRun: boolean) {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/admin/questions/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ csv, status, dryRun }),
      });
      const body = (await res.json()) as { report?: ImportReport; error?: { message: string } };
      if (!res.ok || !body.report) {
        throw new Error(body.error?.message ?? "Import failed.");
      }
      setReport(body.report);
      if (!dryRun && body.report.created > 0) onImported();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  async function readFile(file: File) {
    setError(null);
    if (file.size > 4 * 1024 * 1024) {
      setError("That file is larger than 4 MB. Split it and import in parts.");
      return;
    }
    setFileName(file.name);
    setCsv(await file.text());
    setReport(null);
  }

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900">Import questions from CSV</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close import"
          className="rounded p-1 text-slate-400 hover:bg-slate-200"
        >
          <X className="size-4" />
        </button>
      </div>

      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <p className="text-xs text-slate-500">
        Columns: <code className="rounded bg-slate-200 px-1">stem</code>,{" "}
        <code className="rounded bg-slate-200 px-1">option_a</code> …{" "}
        <code className="rounded bg-slate-200 px-1">option_e</code>,{" "}
        <code className="rounded bg-slate-200 px-1">correct</code>, then optional{" "}
        <code className="rounded bg-slate-200 px-1">explanation</code>,{" "}
        <code className="rounded bg-slate-200 px-1">backstory</code>,{" "}
        <code className="rounded bg-slate-200 px-1">difficulty</code>,{" "}
        <code className="rounded bg-slate-200 px-1">topic</code>,{" "}
        <code className="rounded bg-slate-200 px-1">tags</code>,{" "}
        <code className="rounded bg-slate-200 px-1">year</code>,{" "}
        <code className="rounded bg-slate-200 px-1">exam_body</code>,{" "}
        <code className="rounded bg-slate-200 px-1">source</code>,{" "}
        <code className="rounded bg-slate-200 px-1">source_url</code>. Export a CSV first to
        see the exact shape.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
          <FileUp className="size-4" />
          {fileName ?? "Choose a .csv file"}
          <input
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void readFile(file);
            }}
          />
        </label>

        <label className="flex items-center gap-2 text-xs font-medium text-slate-600">
          Import as
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
          >
            <option value="active">Active</option>
            <option value="archived">Archived</option>
          </select>
        </label>

        <div className="ml-auto flex gap-2">
          <button
            type="button"
            disabled={busy || csv.trim() === ""}
            onClick={() => void run(true)}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {busy ? "Checking…" : "Dry run"}
          </button>
          <button
            type="button"
            disabled={busy || csv.trim() === "" || report?.dryRun === false}
            onClick={() => void run(false)}
            title="Run a dry run first — that is the point of it"
            className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-40"
          >
            <Upload className="size-4" />
            Import
          </button>
        </div>
      </div>

      {csv && (
        <textarea
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
          rows={4}
          spellCheck={false}
          aria-label="CSV content"
          className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-xs"
        />
      )}

      {report && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            {report.dryRun ? (
              <span className="inline-flex items-center gap-1.5 font-semibold text-sky-700">
                <Copy className="size-4" />
                Dry run — nothing was written
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 font-semibold text-emerald-700">
                <CheckCircle2 className="size-4" />
                Imported
              </span>
            )}
            <span className="text-slate-500">
              {report.total} rows · <strong className="text-emerald-700">{report.created} created</strong> ·{" "}
              <strong className="text-amber-700">{report.duplicates} duplicate</strong> ·{" "}
              <strong className="text-red-700">{report.invalid} invalid</strong>
            </span>
          </div>

          <div className="max-h-80 overflow-y-auto rounded-lg border border-slate-200 bg-white">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-slate-50 text-slate-500">
                <tr>
                  <th className="px-3 py-2 font-medium">Row</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Question</th>
                  <th className="px-3 py-2 font-medium">Detail</th>
                </tr>
              </thead>
              <tbody>
                {report.results.map((row) => (
                  <tr key={`${row.row}-${row.status}`} className="border-t border-slate-100">
                    <td className="px-3 py-2 tabular-nums text-slate-400">{row.row}</td>
                    <td className="px-3 py-2">
                      <span
                        className={cn(
                          "rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                          STATUS_TONE[row.status],
                        )}
                      >
                        {STATUS_LABEL[row.status]}
                      </span>
                    </td>
                    <td className="max-w-xs truncate px-3 py-2 text-slate-700">{row.stem}</td>
                    <td className="px-3 py-2 text-slate-500">
                      {row.reasons?.join("; ")}
                      {row.matchedStem && (
                        <span className="text-slate-400"> (matches “{row.matchedStem}”)</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
