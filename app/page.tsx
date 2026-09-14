import { CategoryCard } from "@/components/cards/CategoryCard";
import { CardGrid } from "@/components/grid/CardGrid";
import { listRootCategories } from "@/modules/catalog";

// Content is read per request so admin edits appear immediately. PLAN.md §17.4
// defers CDN caching to M8; adding it now would mask real query problems.
export const dynamic = "force-dynamic";

export default async function HomePage() {
  const categories = await listRootCategories();

  return (
    <div className="flex flex-col gap-6">
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
