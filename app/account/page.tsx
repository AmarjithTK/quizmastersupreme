import Link from "next/link";
import { redirect } from "next/navigation";
import { BarChart3, Clock, Flame, Target, Trophy } from "lucide-react";
import { getCurrentPageUser } from "@/lib/server/get-current-user";
import {
  getDashboardStats,
  getInProgressAttempts,
  getUserHistory,
  getWeakTopics,
} from "@/modules/progress";
import { cn, formatNumber } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const metadata = { title: "Your account" };

/**
 * Account dashboard (PLAN.md §8.4, M6).
 *
 * Deliberately small: four numbers, what you are part-way through, what you did
 * recently, and where you are weak. A quiz platform's dashboard should answer
 * "what should I do next", not entertain.
 */
export default async function AccountPage() {
  const user = await getCurrentPageUser();
  if (!user) redirect("/login?redirect=/account");

  const [stats, inProgress, history, weakTopics] = await Promise.all([
    getDashboardStats(user.id),
    getInProgressAttempts(user.id),
    getUserHistory(user.id, { pageSize: 5 }),
    getWeakTopics(user.id),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {user.displayName ?? "Your account"}
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            {user.email}
            {user.role === "admin" && " · administrator"}
          </p>
        </div>
        <Link
          href="/account/history"
          className="rounded-lg border border-slate-300 bg-white px-3.5 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50"
        >
          Full history
        </Link>
      </header>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile
          icon={<BarChart3 className="size-4" />}
          label="Questions answered"
          value={formatNumber(stats.answered)}
          hint={`${formatNumber(stats.distinctQuestions)} distinct`}
        />
        <Tile
          icon={<Target className="size-4" />}
          label="Accuracy"
          value={`${stats.accuracy}%`}
          hint={`${formatNumber(stats.correct)} correct`}
          tone={
            stats.answered === 0
              ? undefined
              : stats.accuracy >= 70
                ? "text-emerald-600"
                : stats.accuracy >= 50
                  ? "text-amber-600"
                  : "text-rose-600"
          }
        />
        <Tile
          icon={<Trophy className="size-4" />}
          label="Sets completed"
          value={formatNumber(stats.setsCompleted)}
          hint={`${formatNumber(stats.setsStarted)} started`}
        />
        <Tile
          icon={<Flame className="size-4" />}
          label="In progress"
          value={formatNumber(inProgress.length)}
          hint={inProgress.length > 0 ? "Pick up where you left off" : "Nothing unfinished"}
        />
      </section>

      {inProgress.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Continue where you left off
          </h2>
          <ul className="flex flex-col gap-2">
            {inProgress.map((item) => (
              <li
                key={item.attemptId}
                className="flex flex-wrap items-center gap-3 rounded-2xl border border-slate-200 bg-white p-4"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-slate-900">{item.setTitle}</p>
                  <p className="text-xs text-slate-500">
                    {item.categoryTitle && <>{item.categoryTitle} · </>}
                    {item.answeredCount}/{item.totalQuestions} answered
                    {item.correctCount > 0 && ` · ${item.correctCount} correct`}
                  </p>
                  <div className="mt-2 h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-slate-100">
                    <div
                      className="h-full rounded-full bg-slate-900"
                      style={{ width: `${item.percent}%` }}
                    />
                  </div>
                </div>
                <Link
                  href={`/quiz/${item.setId}`}
                  className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700"
                >
                  Resume
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="flex flex-col gap-3">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Recent attempts
          </h2>

          {history.rows.length === 0 ? (
            <p className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-500">
              No attempts yet. Pick a subject from the home screen to start.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {history.rows.map((item) => (
                <li
                  key={item.attemptId}
                  className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-slate-900">{item.setTitle}</p>
                    <p className="text-xs text-slate-500">
                      {statusLabel(item.status)} · {item.correctCount}/{item.totalQuestions} ·{" "}
                      {formatDay(item.completedAt ?? item.startedAt)}
                    </p>
                  </div>
                  <span
                    className={cn(
                      "text-sm font-semibold tabular-nums",
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
                    className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-500 hover:bg-slate-100"
                  >
                    Review
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Weakest topics
          </h2>

          {weakTopics.length === 0 ? (
            <p className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-500">
              Answer a few more questions and your weakest topics will appear here.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {weakTopics.map((topic) => (
                <li
                  key={topic.topic}
                  className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3"
                >
                  <Clock className="size-4 shrink-0 text-slate-300" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-slate-900">{topic.topic}</p>
                    <p className="text-xs text-slate-500">
                      {topic.correct}/{topic.answered} correct
                    </p>
                  </div>
                  <span className="text-sm font-semibold tabular-nums text-rose-600">
                    {topic.accuracy}%
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function Tile({
  icon,
  label,
  value,
  hint,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
  tone?: string;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-slate-500">
        {icon}
        {label}
      </p>
      <p className={cn("mt-1 text-3xl font-semibold tabular-nums", tone ?? "text-slate-900")}>
        {value}
      </p>
      {hint && <p className="mt-0.5 text-xs text-slate-400">{hint}</p>}
    </div>
  );
}

function statusLabel(status: string): string {
  switch (status) {
    case "completed":
      return "Completed";
    case "expired":
      return "Time ran out";
    case "abandoned":
      return "Abandoned";
    case "in_progress":
      return "In progress";
    default:
      return status;
  }
}

function formatDay(ms: number): string {
  return new Date(ms).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}
