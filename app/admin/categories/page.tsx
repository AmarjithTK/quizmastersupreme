import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentPageUser } from "@/lib/server/get-current-user";
import { listCategoriesForAdmin } from "@/modules/catalog";
import { CategoryManager } from "@/components/admin/CategoryManager";
import { ForbiddenCard } from "@/components/admin/forbidden";

export const metadata = { title: "Subjects · Admin" };

/**
 * M2 — category management. The home grid is not hard-coded: subjects created
 * here appear on screen 1 as cards once published (PLAN.md §8.1, §9.2).
 */
export default async function AdminCategoriesPage() {
  const user = await getCurrentPageUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") return <ForbiddenCard />;

  const categories = await listCategoriesForAdmin();

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Subjects</h1>
          <p className="mt-1 text-sm text-slate-500">
            These cards are what visitors see on the home screen.
          </p>
        </div>
        <Link
          href="/admin"
          className="rounded-lg px-3 py-1.5 text-sm font-medium text-slate-500 hover:bg-slate-100"
        >
          ← Admin
        </Link>
      </header>

      <CategoryManager initial={categories} />
    </div>
  );
}