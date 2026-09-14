import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentPageUser } from "@/lib/server/get-current-user";
import { bindings } from "@/lib/cloudflare/bindings";
import { listCategoriesForAdmin } from "@/modules/catalog";
import { listJobs, openRouterKeyConfigured, promptVersionStats, type PromptVersionStats } from "@/modules/ai";
import { GenerationPanel } from "@/components/admin/GenerationPanel";
import { ForbiddenCard } from "@/components/admin/forbidden";

export const dynamic = "force-dynamic";
export const metadata = { title: "Generate · Admin" };

/**
 * M10 — the generation screen.
 *
 * Nothing produced here reaches learners. Every candidate lands in the review
 * queue and a human decides (§2.2).
 */
export default async function AdminGeneratePage() {
  const user = await getCurrentPageUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") return <ForbiddenCard />;

  const [jobs, categories, stats] = await Promise.all([
    listJobs(30),
    listCategoriesForAdmin(),
    promptVersionStats(),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Generate questions</h1>
          <p className="mt-1 text-sm text-slate-500">
            Draft a batch with a model, then review every question before it reaches the bank.
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            href="/admin/review"
            className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50"
          >
            Review queue
          </Link>
          <Link
            href="/admin"
            className="rounded-lg px-3 py-1.5 text-sm font-medium text-slate-500 hover:bg-slate-100"
          >
            ← Admin
          </Link>
        </div>
      </header>

      <PromptStats stats={stats} />

      <GenerationPanel
        initialJobs={jobs.map((job) => ({
          id: job.id,
          topic: job.topic,
          model: job.model,
          status: job.status,
          requestedCount: job.requestedCount,
          producedCount: job.producedCount,
          validCount: job.validCount,
          duplicateCount: job.duplicateCount,
          costUsd: job.costUsd,
          errorCode: job.errorCode,
          errorMessage: job.errorMessage,
          createdAt: job.createdAt,
        }))}
        configured={openRouterKeyConfigured()}
        defaultModel={bindings().DEFAULT_GENERATION_MODEL}
        categories={categories.map((c) => ({ id: c.id, title: c.title }))}
      />
    </div>
  );
}

/**
 * M13 — how is each prompt version actually doing? Decisions made by humans,
 * counted against the version that produced the candidates. Pending/deferred
 * are excluded from the denominator so a long queue cannot inflate quality.
 */
function PromptStats({ stats }: { stats: PromptVersionStats[] }) {
  if (stats.length === 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-500">
        No generation results yet — prompt statistics appear here once jobs have run.
      </div>
    );
  }
  const pct = (n: number | null) => (n === null ? "—" : `${Math.round(n * 100)}%`);
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-slate-700">Prompt performance</h2>
      <p className="mt-1 text-xs text-slate-400">
        Acceptance = approved ÷ (approved + rejected + merged); pending and deferred are not
        counted against a prompt. Duplicate rate is of produced candidates.
      </p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-left text-xs text-slate-600">
          <thead className="border-b border-slate-200 text-slate-400">
            <tr>
              <th className="py-2 pr-3 font-medium">Prompt</th>
              <th className="py-2 pr-3 font-medium">Jobs</th>
              <th className="py-2 pr-3 font-medium">Produced</th>
              <th className="py-2 pr-3 font-medium">Valid</th>
              <th className="py-2 pr-3 font-medium">Dupes</th>
              <th className="py-2 pr-3 font-medium">Approved</th>
              <th className="py-2 pr-3 font-medium">Rejected</th>
              <th className="py-2 pr-3 font-medium">Pending</th>
              <th className="py-2 pr-3 font-medium">Accept</th>
              <th className="py-2 pr-3 font-medium">Dup rate</th>
            </tr>
          </thead>
          <tbody>
            {stats.map((row) => (
              <tr key={row.promptVersion} className="border-b border-slate-100">
                <td className="py-2 pr-3 font-mono text-[11px] text-slate-700">{row.promptVersion}</td>
                <td className="py-2 pr-3">{row.jobs}</td>
                <td className="py-2 pr-3">{row.produced}</td>
                <td className="py-2 pr-3">{row.valid}</td>
                <td className="py-2 pr-3">{row.duplicates}</td>
                <td className="py-2 pr-3 text-emerald-600">{row.approved}</td>
                <td className="py-2 pr-3 text-rose-600">{row.rejected}</td>
                <td className="py-2 pr-3">{row.pending}</td>
                <td className="py-2 pr-3 font-semibold text-slate-800">{pct(row.acceptanceRate)}</td>
                <td className="py-2 pr-3">{pct(row.duplicateRate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
