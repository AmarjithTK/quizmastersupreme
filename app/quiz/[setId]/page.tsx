import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentPageUser } from "@/lib/server/get-current-user";
import { ApiError } from "@/lib/errors";
import { getAttemptQuestions, getAttemptState, startOrResumeAttempt } from "@/modules/quiz";
import { getLatestFinishedAttempt } from "@/modules/progress";
import { QuizRunner } from "@/components/quiz/QuizRunner";

export const dynamic = "force-dynamic";

type PageProps = { params: Promise<{ setId: string }> };

/**
 * SCREEN 3 — the quiz runner (PLAN.md §8.3).
 *
 * Starting and resuming are the same URL and the same call: `startOrResumeAttempt`
 * returns the in-progress attempt if one exists, so returning to this page picks
 * up exactly where the user stopped (§11.4).
 */
export const metadata = { title: "Quiz" };

export default async function QuizPage({ params }: PageProps) {
  const { setId } = await params;

  const user = await getCurrentPageUser();
  if (!user) redirect(`/login?redirect=${encodeURIComponent(`/quiz/${setId}`)}`);

  let attemptId: string;
  let resumed = false;
  let previous: Awaited<ReturnType<typeof getLatestFinishedAttempt>> = null;
  try {
    const started = await startOrResumeAttempt(user.id, setId);
    // A finished attempt belongs on the results page, not in the runner.
    if (started.attempt.status !== "in_progress") redirect(`/attempts/${started.attempt.id}`);
    attemptId = started.attempt.id;
    resumed = started.resumed;

    // Starting a FRESH paper when a previous one ended deserves a word: without
    // this, a timed-out attempt disappears silently and its score is never seen.
    if (!resumed) previous = await getLatestFinishedAttempt(user.id, setId);
  } catch (error) {
    if (error instanceof ApiError && error.code === "NOT_FOUND") notFound();
    return (
      <div className="mx-auto max-w-md py-16 text-center">
        <h1 className="text-xl font-semibold">This quiz cannot be started</h1>
        <p className="mt-2 text-sm text-slate-500">
          {error instanceof ApiError ? error.message : "Something went wrong."}
        </p>
      </div>
    );
  }

  const state = await getAttemptState(attemptId, user.id);
  // First window only — never ship the whole paper, and never any answer key.
  const questions = await getAttemptQuestions(attemptId, user.id, state.resumeIndex, 5);

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-lg font-semibold tracking-tight sm:text-xl">{state.setTitle}</h1>
        {state.mode === "mock" && (
          <span className="rounded bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600">
            Mock test
          </span>
        )}
      </header>

      {previous && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600">
          <span>
            {previous.status === "expired"
              ? "Your previous attempt on this set ran out of time."
              : previous.status === "abandoned"
                ? "You abandoned your previous attempt on this set."
                : "You completed this set before."}{" "}
            Last result: <strong className="font-semibold">{previous.percent}%</strong>.
          </span>
          <Link
            href={`/attempts/${previous.attemptId}`}
            className="font-medium text-slate-900 underline underline-offset-2"
          >
            Review it
          </Link>
        </div>
      )}

      <QuizRunner attempt={state} initialQuestions={questions} />
    </div>
  );
}
