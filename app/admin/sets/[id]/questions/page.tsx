import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentPageUser } from "@/lib/server/get-current-user";
import { getSetForAdmin } from "@/modules/catalog";
import { listSetQuestions } from "@/modules/questions";
import { SetQuestionsManager } from "@/components/admin/SetQuestionsManager";
import { ForbiddenCard } from "@/components/admin/forbidden";
import { cn, formatDuration } from "@/lib/utils";

export const dynamic = "force-dynamic";

type PageProps = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: PageProps) {
  const { id } = await params;
  const set = await getSetForAdmin(id);
  return { title: set ? `${set.title} · Questions` : "Quiz set" };
}

/** M4 — which questions are in this set, and in what order. */
export default async function AdminSetQuestionsPage({ params }: PageProps) {
  const user = await getCurrentPageUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") return <ForbiddenCard />;

  const { id } = await params;
  const set = await getSetForAdmin(id);
  if (!set) notFound();

  const questions = await listSetQuestions(id);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link
            href="/admin/sets"
            className="text-xs font-medium text-slate-500 hover:text-slate-900"
          >
            ← Quiz sets
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">{set.title}</h1>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-3 text-sm text-slate-500">
            <span>{set.categoryTitle}</span>
            <span className="text-slate-300">·</span>
            <span>{set.questionCount} questions</span>
            {formatDuration(set.timeLimitSeconds) && (
              <>
                <span className="text-slate-300">·</span>
                <span>{formatDuration(set.timeLimitSeconds)}</span>
              </>
            )}
            <span
              className={cn(
                "rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                set.status === "published"
                  ? "bg-emerald-50 text-emerald-700"
                  : "bg-amber-50 text-amber-700",
              )}
            >
              {set.status}
            </span>
          </p>
        </div>
      </header>

      {set.status !== "published" && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          This set is not published yet, so learners cannot see it. Publish it from
          <Link href="/admin/sets" className="ml-1 font-medium underline">
            Quiz sets
          </Link>
          .
        </p>
      )}

      <SetQuestionsManager setId={id} initialQuestions={questions} />
    </div>
  );
}
