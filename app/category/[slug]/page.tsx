import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { SetCard } from "@/components/cards/SetCard";
import { CardGrid, SectionHeading } from "@/components/grid/CardGrid";
import { CategoryIcon } from "@/components/ui/category-icon";
import { accentFor } from "@/components/cards/accents";
import { formatNumber, cn } from "@/lib/utils";
import { getCategoryBySlug, groupSets, listSetsForCategory } from "@/modules/catalog";

export const dynamic = "force-dynamic";

type PageProps = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: PageProps) {
  const { slug } = await params;
  const category = await getCategoryBySlug(slug);
  return { title: category?.title ?? "Subject not found" };
}

export default async function CategoryPage({ params }: PageProps) {
  const { slug } = await params;
  const category = await getCategoryBySlug(slug);
  if (!category) notFound();

  const sets = await listSetsForCategory(category.id);
  const groups = groupSets(sets);
  const accent = accentFor(category.accentColor);
  const showGroupHeadings = groups.length > 1 || groups[0]?.label !== null;

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
                  <SetCard key={set.id} set={set} />
                ))}
              </CardGrid>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
