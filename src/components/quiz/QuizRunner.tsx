"use client";

/**
 * The quiz runner — SCREEN 3 (PLAN.md §8.3, §11).
 *
 * Behaviour that matters:
 *  - An answer is submitted the moment it is chosen, never batched to the end,
 *    so closing the tab loses nothing (§2.5).
 *  - The reveal (correctness + explanation + backstory) only appears after the
 *    server confirms the answer. The client never knows the key before that.
 *  - The timer is display-only; the server owns the deadline (§11.5).
 *  - Advancing prefetches ahead, so the next question is already in memory.
 */

import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Flag,
  HelpCircle,
  XCircle,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { BackstoryRenderer } from "@/components/backstory/BackstoryRenderer";
import { cn } from "@/lib/utils";
import { QuestionMap, type QuestionCell } from "./QuestionMap";
import { Timer } from "./Timer";
import type { AnswerResult, AttemptQuestion, AttemptState } from "@/modules/quiz";

type OptionKey = "A" | "B" | "C" | "D" | "E";

const BATCH = 5;

export function QuizRunner({
  attempt: initialAttempt,
  initialQuestions,
}: {
  attempt: AttemptState;
  initialQuestions: AttemptQuestion[];
}) {
  const router = useRouter();

  const [attempt, setAttempt] = useState(initialAttempt);
  const [loaded, setLoaded] = useState<Map<number, AttemptQuestion>>(
    () => new Map(initialQuestions.map((q) => [q.index, q])),
  );
  const [index, setIndex] = useState(initialAttempt.resumeIndex);
  const [reveals, setReveals] = useState<Map<string, AnswerResult>>(new Map());
  const [cells, setCells] = useState<QuestionCell[]>(() =>
    initialAttempt.answers.map((a) => ({
      index: a.index,
      isCorrect: a.isCorrect,
      answered: a.selectedOptionKey !== null,
    })),
  );

  const [pending, setPending] = useState<OptionKey | null>(null);
  const [revealLoading, setRevealLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [finishing, setFinishing] = useState(false);

  const finishedRef = useRef(false);

  // ── data loading ─────────────────────────────────────────────────────────

  const loadBatch = useCallback(
    async (from: number) => {
      const res = await fetch(
        `/api/attempts/${initialAttempt.attemptId}/questions?from=${from}&count=${BATCH}`,
      );
      if (!res.ok) return;
      const data = (await res.json()) as { questions?: AttemptQuestion[] };
      setLoaded((prev) => {
        const next = new Map(prev);
        for (const question of data.questions ?? []) next.set(question.index, question);
        return next;
      });
    },
    [initialAttempt.attemptId],
  );

  const ensureReveal = useCallback(
    async (questionId: string) => {
      if (reveals.has(questionId)) return;
      setRevealLoading(true);
      try {
        const res = await fetch(
          `/api/attempts/${initialAttempt.attemptId}/reveal/${questionId}`,
        );
        if (res.ok) {
          const data = (await res.json()) as { result?: AnswerResult };
          if (data.result) {
            setReveals((prev) => new Map(prev).set(questionId, data.result!));
          }
        }
      } finally {
        setRevealLoading(false);
      }
    },
    [initialAttempt.attemptId, reveals],
  );

  // Prefetch the window around the current question.
  useEffect(() => {
    const needle = index + 2;
    if (!loaded.has(needle) && needle < attempt.totalQuestions) {
      void loadBatch(index);
    }
  }, [index, loaded, attempt.totalQuestions, loadBatch]);

  // ── actions ──────────────────────────────────────────────────────────────

  const jumpTo = (target: number) => {
    setError(null);
    setIndex(target);
    const cell = cells.find((c) => c.index === target);
    if (cell?.answered) {
      const question = loaded.get(target);
      if (question) void ensureReveal(question.questionId);
    }
  };

  const choose = async (key: OptionKey) => {
    const question = loaded.get(index);
    if (!question || pending || reveals.has(question.questionId)) return;

    setError(null);
    setPending(key);
    try {
      const res = await fetch(`/api/attempts/${initialAttempt.attemptId}/answers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ questionId: question.questionId, selectedOptionKey: key }),
      });
      const body = (await res.json()) as {
        result?: AnswerResult;
        error?: { message: string };
      };
      if (!res.ok || !body.result) {
        throw new Error(body.error?.message ?? "Could not save that answer.");
      }

      const result = body.result;
      setReveals((prev) => new Map(prev).set(question.questionId, result));
      setAttempt((prev) => ({
        ...prev,
        answeredCount: result.runningScore.answered,
        correctCount: result.runningScore.correct,
        wrongCount: result.runningScore.wrong,
      }));
      setCells((prev) =>
        prev.map((c) =>
          c.index === index
            ? { ...c, answered: true, isCorrect: result.isCorrect ? 1 : 0 }
            : c,
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setPending(null);
    }
  };

  const finish = useCallback(async () => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    setFinishing(true);
    try {
      await fetch(`/api/attempts/${initialAttempt.attemptId}/complete`, { method: "POST" });
    } finally {
      router.push(`/attempts/${initialAttempt.attemptId}`);
    }
  }, [initialAttempt.attemptId, router]);

  const next = () => {
    if (index >= attempt.totalQuestions - 1) {
      const blanks = attempt.totalQuestions - attempt.answeredCount;
      const message =
        blanks > 0
          ? `You have ${blanks} unanswered ${blanks === 1 ? "question" : "questions"}. Unanswered questions score zero. Finish anyway?`
          : "Finish and see your result?";
      if (window.confirm(message)) void finish();
      return;
    }
    jumpTo(index + 1);
  };

  const giveUp = async () => {
    if (!window.confirm("Abandon this attempt? Your answers are kept, but it will not be scored.")) {
      return;
    }
    await fetch(`/api/attempts/${initialAttempt.attemptId}/abandon`, { method: "POST" });
    router.push(`/sets/${attempt.setId}`);
  };

  // ── render ───────────────────────────────────────────────────────────────

  const question = loaded.get(index);
  const reveal = question ? reveals.get(question.questionId) : undefined;
  const progressPct =
    attempt.totalQuestions > 0
      ? Math.round((attempt.answeredCount / attempt.totalQuestions) * 100)
      : 0;

  if (!question) {
    return (
      <div className="mx-auto max-w-md py-16 text-center">
        <p className="text-sm text-slate-500">Loading question {index + 1}…</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
      {/* ── question column ─────────────────────────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col gap-4">
        <div className="flex items-center justify-between gap-4">
          <span className="text-sm font-medium text-slate-500">
            Question {index + 1} of {attempt.totalQuestions}
          </span>
          <div className="lg:hidden">
            <Timer deadlineAt={attempt.serverDeadlineAt} onExpire={finish} />
          </div>
        </div>

        {error && (
          <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
          <p className="text-base font-medium leading-7 text-slate-900 sm:text-lg">
            {question.stem}
          </p>

          <div className="mt-5 flex flex-col gap-2.5">
            {question.options.map((option) => {
              const isChosen = reveal
                ? reveal.correctOptionKey === option.key
                : pending === option.key;

              let tone =
                "border-slate-200 bg-white hover:border-slate-400 hover:bg-slate-50";
              if (reveal) {
                if (reveal.correctOptionKey === option.key) {
                  tone = "border-emerald-400 bg-emerald-50";
                } else {
                  tone = "border-slate-200 bg-white opacity-70";
                }
              } else if (pending === option.key) {
                tone = "border-slate-400 bg-slate-50";
              }

              return (
                <button
                  key={option.key}
                  type="button"
                  disabled={pending !== null || reveal !== undefined}
                  onClick={() => choose(option.key as OptionKey)}
                  className={cn(
                    "flex w-full items-start gap-3 rounded-xl border px-4 py-3 text-left transition-colors",
                    "disabled:cursor-default focus-visible:outline-none focus-visible:ring-2",
                    "focus-visible:ring-slate-900 focus-visible:ring-offset-2",
                    tone,
                  )}
                >
                  <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border border-current text-xs font-semibold text-slate-500">
                    {option.key}
                  </span>
                  <span className="text-sm leading-6 text-slate-800">{option.body}</span>
                  {reveal && reveal.correctOptionKey === option.key && (
                    <CheckCircle2 className="ml-auto mt-0.5 size-5 shrink-0 text-emerald-600" />
                  )}
                  {isChosen && !reveal && <span className="ml-auto text-xs text-slate-400">saving…</span>}
                </button>
              );
            })}
          </div>
        </div>

        {/* ── reveal ────────────────────────────────────────────────────── */}
        {reveal && (
          <div className="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
            <div className="flex items-center gap-2">
              {reveal.isCorrect ? (
                <>
                  <CheckCircle2 className="size-5 text-emerald-600" />
                  <span className="font-semibold text-emerald-700">Correct</span>
                </>
              ) : (
                <>
                  <XCircle className="size-5 text-rose-600" />
                  <span className="font-semibold text-rose-700">
                    Incorrect — the answer is {reveal.correctOptionKey}
                  </span>
                </>
              )}
            </div>

            {reveal.explanation && (
              <p className="text-sm leading-6 text-slate-600">{reveal.explanation}</p>
            )}

            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                Backstory
              </h3>
              <BackstoryRenderer content={reveal.backstory} format={reveal.backstoryFormat} />
            </div>

            <div className="flex justify-end">
              <button
                type="button"
                onClick={next}
                className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white hover:bg-slate-700"
              >
                {index >= attempt.totalQuestions - 1 ? (
                  <>
                    <Flag className="size-4" />
                    Finish
                  </>
                ) : (
                  <>
                    Next question
                    <ArrowRight className="size-4" />
                  </>
                )}
              </button>
            </div>
          </div>
        )}

        {revealLoading && (
          <p className="text-xs text-slate-400">Loading this question’s backstory…</p>
        )}

        {!reveal && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <button
              type="button"
              disabled={index === 0}
              onClick={() => jumpTo(index - 1)}
              className="rounded-lg px-3 py-1.5 text-sm font-medium text-slate-500 hover:bg-slate-100 disabled:opacity-40"
            >
              ← Previous
            </button>
            <button
              type="button"
              onClick={next}
              className="rounded-lg px-3 py-1.5 text-sm font-medium text-slate-500 hover:bg-slate-100"
            >
              Skip →
            </button>
          </div>
        )}
      </div>

      {/* ── rail ────────────────────────────────────────────────────────── */}
      <aside className="flex w-full shrink-0 flex-col gap-4 lg:sticky lg:top-20 lg:w-72">
        <div className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-4">
          <div className="hidden items-center justify-between lg:flex">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Time</span>
            <Timer deadlineAt={attempt.serverDeadlineAt} onExpire={finish} />
          </div>

          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between text-xs text-slate-500">
              <span>Progress</span>
              <span>
                {attempt.answeredCount}/{attempt.totalQuestions}
              </span>
            </div>
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100"
              role="progressbar"
              aria-valuenow={progressPct}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div className="h-full rounded-full bg-slate-900" style={{ width: `${progressPct}%` }} />
            </div>
          </div>

          <div className="flex items-center justify-between text-xs">
            <span className="text-emerald-600">{attempt.correctCount} correct</span>
            <span className="text-rose-600">{attempt.wrongCount} wrong</span>
          </div>
        </div>

        <div className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-4">
          <div className="flex items-center gap-1.5">
            <HelpCircle className="size-3.5 text-slate-400" />
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Questions
            </span>
          </div>
          <QuestionMap
            cells={cells}
            currentIndex={index}
            onJump={jumpTo}
            disabled={pending !== null || finishing}
          />

          <button
            type="button"
            onClick={() => void giveUp()}
            disabled={finishing}
            className="mt-1 rounded-lg px-3 py-1.5 text-xs font-medium text-slate-400 hover:bg-slate-100 hover:text-slate-600 disabled:opacity-50"
          >
            Abandon attempt
          </button>
        </div>
      </aside>
    </div>
  );
}
