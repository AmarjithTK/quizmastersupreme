import { notFound, redirect } from "next/navigation";
import { getCurrentPageUser } from "@/lib/server/get-current-user";
import { ApiError } from "@/lib/errors";
import { getAttemptQuestions, getAttemptState, startOrResumeAttempt } from "@/modules/quiz";
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
  try {
    const { attempt } = await startOrResumeAttempt(user.id, setId);
    // A finished attempt belongs on the results page, not in the runner.
    if (attempt.status !== "in_progress") redirect(`/attempts/${attempt.id}`);
    attemptId = attempt.id;
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

      <QuizRunner attempt={state} initialQuestions={questions} />
    </div>
  );
}
