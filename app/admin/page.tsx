import Link from "next/link";
import { redirect } from "next/navigation";
import { LayoutGrid, ListChecks } from "lucide-react";
import { getCurrentPageUser } from "@/lib/server/get-current-user";
import { ForbiddenCard } from "@/components/admin/forbidden";
import { listCategoriesForAdmin, listSetsForAdmin } from "@/modules/catalog";

export const dynamic = "force-dynamic";
export const metadata = { title: "Admin" };

/**
 * Admin console home (PLAN.md §9). Guards here are UX only — every
 * /api/admin/* handler enforces the same check server-side (§4.3: never trust
 * a page-level check alone).
 */
export default async function AdminPage() {
  const user = await getCurrentPageUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") return <ForbiddenCard />;

  const [categories, sets] = await Promise.all([listCategoriesForAdmin(), listSetsForAdmin()]);
  const publishedSets = sets.filter((s) => s.status === "published").length;
  const draftSets = sets.length - publishedSets;

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Admin console</h1>
        <p className="mt-1 text-sm text-slate-500">
          {categories.length} {categories.length === 1 ? "subject" : "subjects"} ·{" "}
          {sets.length} {sets.length === 1 ? "set" : "sets"} ({publishedSets} published
          {draftSets > 0 && `, ${draftSets} not live`})
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <AdminTile
          href="/admin/categories"
          icon={<LayoutGrid className="size-5" />}
          title="Subjects"
          subtitle="The home-screen cards"
        />
        <AdminTile
          href="/admin/sets"
          icon={<ListChecks className="size-5" />}
          title="Quiz sets"
          subtitle="Playable papers inside a subject"
        />
      </div>

      <p className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
        Questions and AI generation arrive in the next milestones.
      </p>
    </div>
  );
}

function AdminTile({
  href,
  icon,
  title,
  subtitle,
}: {
  href: string;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
}) {
  return (
    <Link
      href={href}
      className="group flex aspect-4/3 flex-col rounded-2xl border border-slate-200 bg-white p-4 transition-all hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-md"
    >
      <span className="flex size-10 items-center justify-center rounded-xl bg-slate-100 text-slate-600">
        {icon}
      </span>
      <span className="mt-auto pt-3">
        <span className="block text-sm font-semibold">{title}</span>
        <span className="text-xs text-slate-500">{subtitle}</span>
      </span>
    </Link>
  );
}