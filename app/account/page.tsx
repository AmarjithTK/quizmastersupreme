import { redirect } from "next/navigation";
import { getCurrentPageUser } from "@/lib/server/get-current-user";

export const metadata = { title: "Your account" };

/**
 * Account dashboard shell (PLAN.md §8.4). Stats, history and weak topics land
 * in M6; until then this page exists so the header link never 404s.
 */
export default async function AccountPage() {
  const user = await getCurrentPageUser();
  if (!user) redirect("/login");

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Your account</h1>
        <p className="mt-1 text-sm text-slate-500">
          Signed in as <span className="font-medium text-slate-700">{user.email}</span>
          {user.role === "admin" && " · administrator"}
        </p>
      </header>

      <p className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
        History, best scores and weak topics will appear here once the quiz
        runner lands (milestone M6).
      </p>
    </div>
  );
}