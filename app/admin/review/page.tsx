import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentPageUser } from "@/lib/server/get-current-user";
import { listCandidates } from "@/modules/ai";
import { ReviewQueue } from "@/components/admin/ReviewQueue";
import { ForbiddenCard } from "@/components/admin/forbidden";

export const dynamic = "force-dynamic";
export const metadata = { title: "Review · Admin" };

/**
 * M10 — the review queue (PLAN.md §9.6).
 *
 * A screen that exists to make one rule enforceable: AI output is never
 * published content (§2.2). If this queue were invisible, it would grow forever
 * and eventually someone would "temporarily" auto-approve it.
 */
export default async function AdminReviewPage() {
  const user = await getCurrentPageUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") return <ForbiddenCard />;

  const candidates = await listCandidates({ reviewStatus: "pending", limit: 50 });

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Review queue</h1>
          <p className="mt-1 text-sm text-slate-500">
            Approving adds a question to the bank (as <em>approved</em>, not published). Publishing
            stays a separate, deliberate action.
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            href="/admin/generate"
            className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50"
          >
            Generate
          </Link>
          <Link
            href="/admin"
            className="rounded-lg px-3 py-1.5 text-sm font-medium text-slate-500 hover:bg-slate-100"
          >
            ← Admin
          </Link>
        </div>
      </header>

      <ReviewQueue
        initial={candidates.map((candidate) => ({
          id: candidate.id,
          jobId: candidate.jobId,
          stem: candidate.stem,
          optionsJson: candidate.optionsJson,
          correctOptionKey: candidate.correctOptionKey,
          explanation: candidate.explanation,
          backstory: candidate.backstory,
          difficulty: candidate.difficulty,
          topic: candidate.topic,
          validationStatus: candidate.validationStatus,
          validationErrors: candidate.validationErrors,
          dedupeStatus: candidate.dedupeStatus,
          dedupeBestMatchId: candidate.dedupeBestMatchId,
          dedupeSimilarity: candidate.dedupeSimilarity,
          reviewStatus: candidate.reviewStatus,
          promotedQuestionId: candidate.promotedQuestionId,
          model: candidate.model,
          jobTopic: candidate.jobTopic,
        }))}
      />
    </div>
  );
}
