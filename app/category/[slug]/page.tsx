import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { SetCard, type SetProgress } from "@/components/cards/SetCard";
import { CardGrid, SectionHeading } from "@/components/grid/CardGrid";
import { CategoryIcon } from "@/components/ui/category-icon";
import { accentFor } from "@/components/cards/accents";
import { getCurrentPageUser } from "@/lib/server/get-current-user";
import { formatNumber, cn } from "@/lib/utils";
import { getCategoryBySlug, groupSets, listSetsForCategory } from "@/modules/catalog";
import { getStatsForSets } from "@/modules/progress";

export const dynamic = "force-dynamic";

type PageProps = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: PageProps) {
  const { slug } = await params;
  const category = await getCategoryBySlug(slug);
  return { title: category?.title ?? "Subject not found" };
}

export default async function CategoryPage({ params }: PageProps) {
  const { slug } = await params;
  const [category, user] = await Promise.all([getCategoryBySlug(slug), getCurrentPageUser()]);
  if (!category) notFound();

  const sets = await listSetsForCategory(category.id);
  const groups = groupSets(sets);
  const accent = accentFor(category.accentColor);
  const showGroupHeadings = groups.length > 1 || groups[0]?.label !== null;

  // Signed-in users see their progress ON the cards, so the grid is both the
  // navigation and the progress view (PLAN.md §8.2). One bulk query, not N.
  const stats = user ? await getStatsForSets(user.id, sets.map((s) => s.id)) : null;

  const progressFor = (setId: string, total: number): SetProgress | undefined => {
    const stat = stats?.get(setId);
    if (!stat) return undefined;
    const answered = Math.min(stat.questionsSeen, total);
    return {
      answered,
      total,
      percent: total > 0 ? Math.round((answered / total) * 100) : 0,
      bestPercent: stat.bestPercent,
      // "Complete" means finished at least once, not merely seen every question.
      isComplete: stat.completedCount > 0,
    };
  };

  return (
    <div className="flex flex-col gap-6">
      <nav>
        <Link
          href="/"
          className="inline-flex items-center gap-1 rounded text-sm text-slate-500 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-2"
        >
          <ChevronLeft className="size-4" />
          All subjects
        </Link>
      </nav>

      <header className="flex items-center gap-4">
        <span
          className={cn("flex size-12 shrink-0 items-center justify-center rounded-xl", accent.tile)}
        >
          <CategoryIcon name={category.icon} className={cn("size-6", accent.icon)} />
        </span>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{category.title}</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            {category.setCount} {category.setCount === 1 ? "set" : "sets"}
            {category.questionCount > 0 && ` · ${formatNumber(category.questionCount)} questions`}
          </p>
        </div>
      </header>

      {sets.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
          No quiz sets in this subject yet.
        </p>
      ) : (
        <div className="flex flex-col gap-6">
          {groups.map((group) => (
            <section key={group.label ?? "__ungrouped"}>
              {showGroupHeadings && group.label && (
                <SectionHeading title={group.label} count={group.sets.length} />
              )}
              <CardGrid>
                {group.sets.map((set) => (
                  <SetCard
                    key={set.id}
                    set={set}
                    progress={progressFor(set.id, set.questionCount)}
                  />
                ))}
              </CardGrid>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

