"use client";

/**
 * The question navigator — one cell per question in the paper.
 *
 * Correctness is shown for answered questions because the server already
 * returned it for those (§2.6: the user earned that knowledge by answering).
 * Unanswered cells reveal nothing.
 */

import { cn } from "@/lib/utils";

export type QuestionCell = {
  index: number;
  isCorrect: number | null;
  answered: boolean;
};

export function QuestionMap({
  cells,
  currentIndex,
  onJump,
  disabled,
}: {
  cells: QuestionCell[];
  currentIndex: number;
  onJump: (index: number) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-1.5" role="list" aria-label="Question navigator">
      {cells.map((cell) => {
        const isCurrent = cell.index === currentIndex;
        const state =
          cell.isCorrect === 1
            ? "bg-emerald-500 text-white"
            : cell.isCorrect === 0
              ? "bg-rose-500 text-white"
              : cell.answered
                ? "bg-slate-400 text-white"
                : "bg-white text-slate-500 border border-slate-200";

        return (
          <button
            key={cell.index}
            type="button"
            role="listitem"
            disabled={disabled}
            onClick={() => onJump(cell.index)}
            aria-label={`Question ${cell.index + 1}${cell.answered ? " (answered)" : ""}`}
            aria-current={isCurrent ? "true" : undefined}
            className={cn(
              "size-7 rounded text-[11px] font-semibold transition-colors disabled:opacity-50",
              state,
              isCurrent && "ring-2 ring-slate-900 ring-offset-1",
            )}
          >
            {cell.index + 1}
          </button>
        );
      })}
    </div>
  );
}

export function scoreTone(percent: number): string {
  if (percent >= 80) return "text-emerald-600";
  if (percent >= 50) return "text-amber-600";
  return "text-rose-600";
}
