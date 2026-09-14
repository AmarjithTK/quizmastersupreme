import { redirect } from "next/navigation";
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
          Manage subjects, quiz sets and questions. Content tools arrive in
          milestones M2–M4.
        </p>
      </header>

      <p className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
        The content management screens are the next milestone.
      </p>
    </div>
  );
}