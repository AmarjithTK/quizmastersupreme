import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentPageUser } from "@/lib/server/get-current-user";
import { getUserHistory } from "@/modules/progress";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const metadata = { title: "History" };

type PageProps = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/**
 * Full attempt history (M6). Every attempt is reviewable, including abandoned
 * and timed-out ones — the point of history is to know what you have already
 * covered (§8.4).
 */
export default async function HistoryPage({ searchParams }: PageProps) {
  const user = await getCurrentPageUser();
  if (!user) redirect("/login?redirect=/account/history");

  const params = await searchParams;
  const raw = typeof params.page === "string" ? Number(params.page) : 1;
  const page = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 1;

  const history = await getUserHistory(user.id, { page, pageSize: 20 });
  const totalPages = Math.max(1, Math.ceil(history.total / history.pageSize));

  return (
    <div className="flex flex-col gap-6">
      <nav>
        <Link href="/account" className="text-sm text-slate-500 hover:text-slate-900">
          ← Account
        </Link>
      </nav>

      <header>
        <h1 className="text-2xl font-semibold tracking-tight">History</h1>
        <p className="mt-1 text-sm text-slate-500">
          {history.total} {history.total === 1 ? "attempt" : "attempts"}
        </p>
      </header>

      {history.rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
          Nothing here yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {history.rows.map((item) => (
            <li
              key={item.attemptId}
              className="flex flex-wrap items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-slate-900">{item.setTitle}</p>
                <p className="text-xs text-slate-500">
                  {item.categoryTitle && <>{item.categoryTitle} · </>}
                  {new Date(item.startedAt).toLocaleString("en-IN", {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                  {" · "}
                  {item.correctCount}/{item.totalQuestions} correct
                </p>
              </div>

              <StatusPill status={item.status} />

              {item.status === "in_progress" ? (
                <Link
                  href={`/quiz/${item.setId}`}
                  className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-700"
                >
                  Resume
                </Link>
              ) : (
                <>
                  <span
                    className={cn(
                      "w-12 text-right text-sm font-semibold tabular-nums",
                      item.percent >= 70
                        ? "text-emerald-600"
                        : item.percent >= 40
                          ? "text-amber-600"
                          : "text-rose-600",
                    )}
                  >
                    {item.percent}%
                  </span>
                  <Link
                    href={`/attempts/${item.attemptId}`}
                    className="rounded-lg px-3 py-1.5 text-xs font-medium text-slate-500 hover:bg-slate-100"
                  >
                    Review
                  </Link>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          {page > 1 ? (
            <Link
              href={`/account/history?page=${page - 1}`}
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
              href={`/account/history?page=${page + 1}`}
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

function StatusPill({ status }: { status: string }) {
  const styles: Record<string, string> = {
    completed: "bg-emerald-50 text-emerald-700",
    expired: "bg-amber-50 text-amber-700",
    abandoned: "bg-slate-100 text-slate-500",
    in_progress: "bg-sky-50 text-sky-700",
  };
  const labels: Record<string, string> = {
    completed: "Completed",
    expired: "Timed out",
    abandoned: "Abandoned",
    in_progress: "In progress",
  };
  return (
    <span
      className={cn(
        "rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
        styles[status] ?? "bg-slate-100 text-slate-500",
      )}
    >
      {labels[status] ?? status}
    </span>
  );
}
