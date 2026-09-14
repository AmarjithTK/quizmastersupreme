import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentPageUser } from "@/lib/server/get-current-user";
import { listDuplicateFlags } from "@/modules/dedupe";
import { getDedupeThresholds } from "@/modules/settings";
import { DuplicateTriage } from "@/components/admin/DuplicateTriage";
import { ForbiddenCard } from "@/components/admin/forbidden";

export const dynamic = "force-dynamic";
export const metadata = { title: "Duplicates · Admin" };

/** M11 — duplicate triage (PLAN.md §9.7). */
export default async function AdminDuplicatesPage() {
  const user = await getCurrentPageUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") return <ForbiddenCard />;

  const [flags, thresholds] = await Promise.all([
    listDuplicateFlags({ status: "open", limit: 100 }),
    getDedupeThresholds(),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Duplicates</h1>
          <p className="mt-1 text-sm text-slate-500">
            Pairs that look like the same question. Flagged, never auto-deleted.
          </p>
        </div>
        <Link
          href="/admin"
          className="rounded-lg px-3 py-1.5 text-sm font-medium text-slate-500 hover:bg-slate-100"
        >
          ← Admin
        </Link>
      </header>

      <DuplicateTriage initialFlags={flags} thresholds={thresholds} />
    </div>
  );
}
