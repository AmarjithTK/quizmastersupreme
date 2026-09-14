import Link from "next/link";
import { PlayCircle } from "lucide-react";
import { CategoryCard } from "@/components/cards/CategoryCard";
import { CardGrid } from "@/components/grid/CardGrid";
import { getCurrentPageUser } from "@/lib/server/get-current-user";
import { listRootCategories } from "@/modules/catalog";
import { getInProgressAttempts } from "@/modules/progress";

// Content is read per request so admin edits appear immediately. PLAN.md §17.4
// defers CDN caching to M8; adding it now would mask real query problems.
export const dynamic = "force-dynamic";

export default async function HomePage() {
  const [categories, user] = await Promise.all([listRootCategories(), getCurrentPageUser()]);

  // Screen 1 answers "what do I want to study?" — but if a paper is already
  // half-finished, that is almost certainly what you came back to do (§8.1).
  const inProgress = user ? await getInProgressAttempts(user.id) : [];
  const resume = inProgress[0];

  return (
    <div className="flex flex-col gap-6">
      {resume && (
        <Link
          href={`/quiz/${resume.setId}`}
          className="group flex flex-wrap items-center gap-3 rounded-2xl border border-slate-900/10 bg-slate-900 p-4 text-white transition-transform hover:-translate-y-0.5"
        >
          <PlayCircle className="size-6 shrink-0 text-white/80" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">
              Continue: {resume.setTitle}
            </p>
            <p className="text-xs text-white/70">
              Question {Math.min(resume.answeredCount + 1, resume.totalQuestions)} of{" "}
              {resume.totalQuestions} · {resume.percent}% done
            </p>
          </div>
          <span className="rounded-xl bg-white/10 px-4 py-2 text-sm font-semibold group-hover:bg-white/20">
            Resume →
          </span>
        </Link>
      )}

      <section>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          What do you want to practise?
        </h1>
        <p className="mt-1 text-sm text-slate-500">Pick a subject to see its quiz sets.</p>
      </section>

      {categories.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
          No subjects yet. An admin can add the first one from the admin console.
        </p>
      ) : (
        <CardGrid>
          {categories.map((category) => (
            <CategoryCard key={category.id} category={category} />
          ))}
        </CardGrid>
      )}
    </div>
  );
}
