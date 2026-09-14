import { cn } from "@/lib/utils";

/**
 * The shared card grid used by BOTH screen 1 (categories) and screen 2 (sets).
 *
 * PLAN.md §8.1: 4 columns on desktop, 2 on phones. One component means the two
 * screens can never drift apart visually.
 */
export function CardGrid({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4 lg:gap-5",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function SectionHeading({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children?: React.ReactNode;
}) {
  return (
    <div className="mb-3 flex items-baseline justify-between gap-4">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
        {title}
        {count !== undefined && <span className="ml-2 text-slate-400">{count}</span>}
      </h2>
      {children}
    </div>
  );
}
