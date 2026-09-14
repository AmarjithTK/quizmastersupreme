import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentPageUser } from "@/lib/server/get-current-user";
import { listCategoriesForAdmin, listSetsForAdmin } from "@/modules/catalog";
import { SetManager } from "@/components/admin/SetManager";
import { ForbiddenCard } from "@/components/admin/forbidden";

export const metadata = { title: "Quiz sets · Admin" };

/**
 * M3 — quiz set management. Sets are DEPTH 2: the terminal content node that
 * users actually play, and what screen 2 renders as cards (§2.1).
 */
export default async function AdminSetsPage() {
  const user = await getCurrentPageUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") return <ForbiddenCard />;

  const [sets, categories] = await Promise.all([listSetsForAdmin(), listCategoriesForAdmin()]);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Quiz sets</h1>
          <p className="mt-1 text-sm text-slate-500">
            Each set is one playable paper inside a subject.
          </p>
        </div>
        <Link
          href="/admin"
          className="rounded-lg px-3 py-1.5 text-sm font-medium text-slate-500 hover:bg-slate-100"
        >
          ← Admin
        </Link>
      </header>

      <SetManager
        initialSets={sets}
        categories={categories.map((c) => ({
          id: c.id,
          title: c.title,
          status: c.status,
        }))}
      />
    </div>
  );
}