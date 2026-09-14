import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentPageUser } from "@/lib/server/get-current-user";
import { listQuestionsForAdmin } from "@/modules/questions";
import { QuestionBank } from "@/components/admin/QuestionBank";
import { ForbiddenCard } from "@/components/admin/forbidden";

export const dynamic = "force-dynamic";
export const metadata = { title: "Questions · Admin" };

/**
 * M4 — the question bank. Authoring here goes through the same validation and
 * duplicate funnel as CSV import and AI promotion (§2.9).
 */
export default async function AdminQuestionsPage() {
  const user = await getCurrentPageUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") return <ForbiddenCard />;

  const initial = await listQuestionsForAdmin({ page: 1, pageSize: 20 });

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Questions</h1>
          <p className="mt-1 text-sm text-slate-500">
            The shared bank. A question can belong to many sets at once.
          </p>
        </div>
        <Link
          href="/admin"
          className="rounded-lg px-3 py-1.5 text-sm font-medium text-slate-500 hover:bg-slate-100"
        >
          ← Admin
        </Link>
      </header>

      <QuestionBank initial={{ rows: initial.rows, total: initial.total }} />
    </div>
  );
}
