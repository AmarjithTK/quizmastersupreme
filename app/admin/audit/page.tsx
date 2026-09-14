import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentPageUser } from "@/lib/server/get-current-user";
import { listAuditEntityTypes, listAuditLog } from "@/modules/audit";
import { ForbiddenCard } from "@/components/admin/forbidden";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const metadata = { title: "Audit log · Admin" };

type PageProps = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/**
 * Audit log (M9, PLAN.md §7.8).
 *
 * Every admin mutation is recorded with a before/after snapshot. This screen
 * makes it readable, which is the only thing that turns the table into a
 * control rather than a write-only log.
 */
export default async function AdminAuditPage({ searchParams }: PageProps) {
  const user = await getCurrentPageUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") return <ForbiddenCard />;

  const params = await searchParams;
  const entityType = typeof params.entityType === "string" ? params.entityType : "";
  const rawPage = typeof params.page === "string" ? Number(params.page) : 1;
  const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.floor(rawPage) : 1;

  const [log, entityTypes] = await Promise.all([
    listAuditLog({ page, pageSize: 30, entityType: entityType || undefined }),
    listAuditEntityTypes(),
  ]);

  const totalPages = Math.max(1, Math.ceil(log.total / log.pageSize));
  const filterHref = (value: string) =>
    value ? `/admin/audit?entityType=${encodeURIComponent(value)}` : "/admin/audit";

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Audit log</h1>
          <p className="mt-1 text-sm text-slate-500">
            {log.total} recorded {log.total === 1 ? "action" : "actions"}
          </p>
        </div>
        <Link
          href="/admin"
          className="rounded-lg px-3 py-1.5 text-sm font-medium text-slate-500 hover:bg-slate-100"
        >
          ← Admin
        </Link>
      </header>

      <nav className="flex flex-wrap gap-2">
        <Link
          href={filterHref("")}
          className={cn(
            "rounded-lg px-3 py-1.5 text-xs font-medium",
            entityType === "" ? "bg-slate-900 text-white" : "bg-white text-slate-600 hover:bg-slate-100",
          )}
        >
          All
        </Link>
        {entityTypes.map((type) => (
          <Link
            key={type}
            href={filterHref(type)}
            className={cn(
              "rounded-lg px-3 py-1.5 text-xs font-medium",
              entityType === type ? "bg-slate-900 text-white" : "bg-white text-slate-600 hover:bg-slate-100",
            )}
          >
            {type}
          </Link>
        ))}
      </nav>

      {log.rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
          Nothing recorded yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {log.rows.map((entry) => (
            <li key={entry.id} className="rounded-xl border border-slate-200 bg-white px-4 py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] font-medium text-slate-700">
                    {entry.action}
                  </span>
                  <span className="text-xs text-slate-500">
                    {entry.entityType}
                    {entry.entityId && (
                      <span className="ml-1 font-mono text-[11px] text-slate-400">
                        {entry.entityId.slice(0, 12)}
                      </span>
                    )}
                  </span>
                </div>
                <span className="text-[11px] text-slate-400">
                  {new Date(entry.createdAt).toLocaleString("en-IN", {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </span>
              </div>

              <p className="mt-1 text-xs text-slate-500">
                by {entry.actorName ?? entry.actorEmail ?? "unknown"}
                {entry.actorEmail && entry.actorName && (
                  <span className="text-slate-400"> · {entry.actorEmail}</span>
                )}
              </p>

              {(entry.beforeJson || entry.afterJson) && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-[11px] font-medium text-slate-400 hover:text-slate-700">
                    before / after
                  </summary>
                  <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-slate-900 p-3 text-[11px] leading-5 text-slate-100">
                    {formatSnapshot(entry.beforeJson, entry.afterJson)}
                  </pre>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          {page > 1 ? (
            <Link
              href={`/admin/audit?page=${page - 1}${entityType ? `&entityType=${entityType}` : ""}`}
              className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50"
            >
              ← Newer
            </Link>
          ) : (
            <span />
          )}
          <span className="text-xs text-slate-500">
            Page {page} of {totalPages}
          </span>
          {page < totalPages ? (
            <Link
              href={`/admin/audit?page=${page + 1}${entityType ? `&entityType=${entityType}` : ""}`}
              className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50"
            >
              Older →
            </Link>
          ) : (
            <span />
          )}
        </div>
      )}
    </div>
  );
}

/** Pretty-print the snapshots; fall back to the raw text if they are not JSON. */
function formatSnapshot(before: string | null, after: string | null): string {
  const pretty = (value: string | null, label: string) => {
    if (!value) return `${label}: —`;
    try {
      return `${label}:\n${JSON.stringify(JSON.parse(value), null, 2)}`;
    } catch {
      return `${label}: ${value}`;
    }
  };
  return `${pretty(before, "BEFORE")}\n\n${pretty(after, "AFTER")}`;
}
