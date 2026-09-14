import Link from "next/link";
import { redirect } from "next/navigation";
import { LayoutGrid } from "lucide-react";
import { getCurrentPageUser } from "@/lib/server/get-current-user";

export const metadata = { title: "Admin" };

/**
 * Admin console shell (PLAN.md §9). The full CRUD screens land in M2–M4; this
 * exists so the header link never 404s and the role gate is already real.
 *
 * The guard here is UX only — every /api/admin/* handler enforces the same
 * check server-side (PLAN.md §4.3: never trust the middleware alone).
 */
export default async function AdminPage() {
  const user = await getCurrentPageUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") {
    return (
      <div className="mx-auto max-w-md py-16 text-center">
        <h1 className="text-xl font-semibold">You do not have access</h1>
        <p className="mt-2 text-sm text-slate-500">
          The admin console is restricted to administrators.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Admin console</h1>
        <p className="mt-1 text-sm text-slate-500">
          Manage subjects, quiz sets and questions.
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Link
          href="/admin/categories"
          className="group flex aspect-4/3 flex-col rounded-2xl border border-slate-200 bg-white p-4 transition-all hover:-translate-y-0.5 hover:shadow-md"
        >
          <span className="flex size-10 items-center justify-center rounded-xl bg-slate-100 text-slate-600">
            <LayoutGrid className="size-5" />
          </span>
          <span className="mt-auto pt-3">
            <span className="block text-sm font-semibold">Subjects</span>
            <span className="text-xs text-slate-500">The home-screen cards</span>
          </span>
        </Link>
      </div>

      <p className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
        Quiz sets, questions and AI generation arrive in the next milestones.
      </p>
    </div>
  );
}