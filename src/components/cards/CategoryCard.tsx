import Link from "next/link";
import { accentFor } from "@/components/cards/accents";
import { CategoryIcon } from "@/components/ui/category-icon";
import { cn, formatNumber } from "@/lib/utils";
import type { CategoryCard as CategoryCardData } from "@/modules/catalog";

/**
 * Screen 1 card. Square, icon-forward, deliberately sparse.
 *
 * PLAN.md §8.1: resist putting more on this card. It answers exactly one
 * question — "what do I want to study?" — and secondary stats belong on
 * screen 2.
 */
export function CategoryCard({ category }: { category: CategoryCardData }) {
  const accent = accentFor(category.accentColor);

  return (
    <Link
      href={`/category/${category.slug}`}
      className={cn(
        "group flex aspect-square flex-col rounded-2xl border border-slate-200 bg-white p-4",
        "transition-all hover:-translate-y-0.5 hover:shadow-md focus-visible:outline-none",
        "focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-2",
        accent.hover,
      )}
    >
      <span
        className={cn(
          "flex size-11 shrink-0 items-center justify-center rounded-xl",
          accent.tile,
        )}
      >
        <CategoryIcon name={category.icon} className={cn("size-6", accent.icon)} />
      </span>

      <span className="mt-auto flex flex-col gap-0.5 pt-3">
        <span className="line-clamp-2 text-sm font-semibold leading-snug text-slate-900 sm:text-base">
          {category.title}
        </span>
        <span className="text-xs text-slate-500">
          {category.setCount === 0
            ? "Coming soon"
            : `${category.setCount} ${category.setCount === 1 ? "set" : "sets"}`}
          {category.questionCount > 0 && (
            <span className="text-slate-400"> · {formatNumber(category.questionCount)} q</span>
          )}
        </span>
      </span>
    </Link>
  );
}
