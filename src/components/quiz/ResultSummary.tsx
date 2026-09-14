/**
 * Results / review view (M5, reused by M6 history).
 *
 * Server-rendered with no client state: the backstories are collapsed behind
 * native <details>, so reviewing a 50-question paper needs zero JavaScript.
 *
 * Safe to show the full answer key because the attempt is finished — the page
 * that renders this redirects an in-progress attempt back to the runner.
 */

import Link from "next/link";
import { CheckCircle2, Clock, MinusCircle, XCircle } from "lucide-react";
import { BackstoryRenderer } from "@/components/backstory/BackstoryRenderer";
import { cn } from "@/lib/utils";
import type { AttemptSummary } from "@/modules/quiz";

function formatDate(ms: number | null): string {
  if (ms == null) return "—";
  return new Date(ms).toLocaleString("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/** Durations on a paper are minutes and seconds, never "2.4 hours". */
export function formatDurationMs(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function ResultSummary({
  summary,
  backHref,
  backLabel,
}: {
  summary: AttemptSummary;
  backHref: string;
  backLabel: string;
}) {
  const { score } = summary;

  const tone =
    score.percent >= 80
      ? "text-emerald-600"
      : score.percent >= 50
        ? "text-amber-600"
        : "text-rose-600";

  return (
    <div className="flex flex-col gap-6">
      <nav>
        <Link href={backHref} className="text-sm text-slate-500 hover:text-slate-900">
          ← {backLabel}
        </Link>
      </nav>

      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{summary.setTitle}</h1>
        <p className="text-sm text-slate-500">
          {summary.status === "completed" && "Completed"}
          {summary.status === "expired" && "Time ran out"}
          {summary.status === "abandoned" && "Abandoned"}
          {" · "}
          {formatDate(summary.completedAt ?? summary.startedAt)}
        </p>
      </header>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Score</p>
          <p className={cn("mt-1 text-3xl font-semibold tabular-nums", tone)}>
            {score.percent}%
          </p>
          {score.passed !== null && (
            <p
              className={cn(
                "mt-1 text-xs font-semibold",
                score.passed ? "text-emerald-600" : "text-rose-600",
              )}
            >
              {score.passed ? "Passed" : "Not passed"}
            </p>
          )}
        </div>
        <Stat label="Correct" value={score.correct} tone="text-emerald-600" icon={<CheckCircle2 className="size-4" />} />
        <Stat label="Wrong" value={score.wrong} tone="text-rose-600" icon={<XCircle className="size-4" />} />
        <Stat label="Unanswered" value={score.skipped} tone="text-slate-500" icon={<MinusCircle className="size-4" />} />
        <Stat
          label="Time on task"
          value={formatDurationMs(summary.timeSpentMs)}
          tone="text-slate-900"
          icon={<Clock className="size-4" />}
        />
      </section>

      {score.skipped > 0 && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Unanswered questions score zero, so your percentage is out of {score.total}, not out
          of the {score.correct + score.wrong} you attempted.
        </p>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Review
        </h2>

        <ol className="flex flex-col gap-3">
          {summary.questions.map((question) => (
            <li key={question.questionId} className="rounded-2xl border border-slate-200 bg-white p-4">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 text-xs font-semibold text-slate-400">
                  {question.index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium leading-6 text-slate-900">{question.stem}</p>
                  <p className="mt-1 flex flex-wrap items-center gap-x-3 text-[11px] text-slate-400">
                    {question.timeTakenMs > 0 && (
                      <span className="inline-flex items-center gap-1">
                        <Clock className="size-3" />
                        {formatDurationMs(question.timeTakenMs)}
                      </span>
                    )}
                    {question.isCorrect === 1 && <span className="text-emerald-600">correct</span>}
                    {question.isCorrect === 0 && <span className="text-rose-600">incorrect</span>}
                    {question.isCorrect === null && <span>not answered</span>}
                  </p>

                  <ul className="mt-3 flex flex-col gap-1.5">
                    {question.options.map((option) => {
                      const chosen = question.selectedOptionKey === option.key;
                      return (
                        <li
                          key={option.key}
                          className={cn(
                            "flex items-start gap-2 rounded-lg border px-3 py-1.5 text-sm",
                            option.isCorrect
                              ? "border-emerald-300 bg-emerald-50"
                              : chosen
                                ? "border-rose-300 bg-rose-50"
                                : "border-slate-200",
                          )}
                        >
                          <span className="font-semibold text-slate-500">{option.key}</span>
                          <span className="text-slate-700">{option.body}</span>
                          {option.isCorrect && (
                            <span className="ml-auto text-[10px] font-semibold uppercase text-emerald-700">
                              correct
                            </span>
                          )}
                          {chosen && !option.isCorrect && (
                            <span className="ml-auto text-[10px] font-semibold uppercase text-rose-700">
                              your answer
                            </span>
                          )}
                          {chosen && option.isCorrect && (
                            <span className="ml-auto text-[10px] font-semibold uppercase text-emerald-700">
                              your answer
                            </span>
                          )}
                        </li>
                      );
                    })}
                  </ul>

                  {(question.explanation || question.backstory) && (
                    <details className="mt-3">
                      <summary className="cursor-pointer text-xs font-medium text-slate-500 hover:text-slate-800">
                        Explanation & backstory
                      </summary>
                      <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
                        {question.explanation && (
                          <p className="mb-3 text-sm leading-6 text-slate-600">
                            {question.explanation}
                          </p>
                        )}
                        <BackstoryRenderer
                          content={question.backstory}
                          format={question.backstoryFormat}
                        />
                      </div>
                    </details>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
  icon,
}: {
  label: string;
  value: number | string;
  tone: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-slate-500">
        {icon}
        {label}
      </p>
      <p className={cn("mt-1 text-3xl font-semibold tabular-nums", tone)}>{value}</p>
    </div>
  );
}
