import Link from "next/link";
import { CheckCircle2, Clock, ListChecks, PlayCircle } from "lucide-react";
import { cn, formatDuration } from "@/lib/utils";
import type { SetCardData } from "@/modules/catalog";

export type SetProgress = {
  answered: number;
  total: number;
  percent: number;
  bestPercent: number | null;
  isComplete: boolean;
};

/**
 * Screen 2 card. Carries the set's metadata plus, once a user is signed in,
 * their progress — so the card grid itself becomes the navigation AND the
 * progress UI (PLAN.md §8.2).
 */
export function SetCard({ set, progress }: { set: SetCardData; progress?: SetProgress }) {
  const duration = formatDuration(set.timeLimitSeconds);
  const isEmpty = set.questionCount === 0;

  const content = (
    <>
      <div className="flex items-start justify-between gap-2">
        <h3 className="line-clamp-2 text-sm font-semibold leading-snug text-slate-900">
          {set.title}
        </h3>
        {progress?.isComplete ? (
          <CheckCircle2
            className="mt-0.5 size-4 shrink-0 text-emerald-600"
            aria-label="Completed"
          />
        ) : (
          !isEmpty && (
            <PlayCircle className="mt-0.5 size-4 shrink-0 text-slate-300 transition-colors group-hover:text-slate-900" />
          )
        )}
      </div>

      <div className="mt-auto flex flex-col gap-2 pt-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
          <span className="inline-flex items-center gap-1">
            <ListChecks className="size-3.5" />
            {isEmpty ? "No questions yet" : `${set.questionCount} questions`}
          </span>
          {duration && (
            <span className="inline-flex items-center gap-1">
              <Clock className="size-3.5" />
              {duration}
            </span>
          )}
          {set.mode === "mock" && (
            <span className="rounded bg-slate-100 px-1.5 py-0.5 font-medium text-slate-600">
              Mock
            </span>
          )}
        </div>

        {progress && progress.total > 0 && (
          <div className="flex flex-col gap-1">
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100"
              role="progressbar"
              aria-valuenow={progress.percent}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`${set.title} progress`}
            >
              <div
                className={cn(
                  "h-full rounded-full",
                  progress.isComplete ? "bg-emerald-500" : "bg-slate-900",
                )}
                style={{ width: `${progress.percent}%` }}
              />
            </div>
            <span className="text-xs text-slate-500">
              {progress.isComplete ? (
                <>Best: {progress.bestPercent ?? 0}%</>
              ) : (
                <>
                  {progress.answered}/{progress.total} answered
                  {progress.bestPercent !== null && <> · Best: {progress.bestPercent}%</>}
                </>
              )}
            </span>
          </div>
        )}
      </div>
    </>
  );

  // An empty set is not a link — there is nothing to play. Showing it greyed out
  // is more honest than a dead card that 404s.
  if (isEmpty) {
    return (
      <div className="flex aspect-4/3 flex-col rounded-2xl border border-dashed border-slate-200 bg-slate-50/50 p-4 opacity-70">
        {content}
      </div>
    );
  }

  return (
    <Link
      href={`/quiz/${set.id}`}
      className={cn(
        "group flex aspect-4/3 flex-col rounded-2xl border border-slate-200 bg-white p-4",
        "transition-all hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-md",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-2",
      )}
    >
      {content}
    </Link>
  );
}
