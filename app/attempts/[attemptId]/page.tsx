import { notFound, redirect } from "next/navigation";
import { getCurrentPageUser } from "@/lib/server/get-current-user";
import { getAttemptSummary } from "@/modules/quiz";
import { ResultSummary } from "@/components/quiz/ResultSummary";

export const dynamic = "force-dynamic";
export const metadata = { title: "Result" };

type PageProps = { params: Promise<{ attemptId: string }> };

/**
 * Results and review.
 *
 * An attempt still in progress is redirected to the runner: this page shows the
 * full answer key, so rendering it mid-attempt would defeat §2.6.
 */
export default async function AttemptPage({ params }: PageProps) {
  const { attemptId } = await params;

  const user = await getCurrentPageUser();
  if (!user) redirect(`/login?redirect=${encodeURIComponent(`/attempts/${attemptId}`)}`);

  let summary;
  try {
    summary = await getAttemptSummary(attemptId, user.id);
  } catch {
    notFound();
  }

  if (summary.status === "in_progress") {
    redirect(`/quiz/${summary.setId}`);
  }

  return (
    <ResultSummary summary={summary} backHref="/" backLabel="Back to subjects" />
  );
}
