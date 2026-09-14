import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentPageUser } from "@/lib/server/get-current-user";
import { bindings } from "@/lib/cloudflare/bindings";
import { listCategoriesForAdmin } from "@/modules/catalog";
import { listJobs, openRouterKeyConfigured, promptVersionStats, type PromptVersionStats } from "@/modules/ai";
import { getAiGenerationSettings } from "@/modules/settings";
import { listSetsForAdmin } from "@/modules/catalog";
import { GenerationPanel } from "@/components/admin/GenerationPanel";
import { ForbiddenCard } from "@/components/admin/forbidden";

export const dynamic = "force-dynamic";
export const metadata = { title: "Generate · Admin" };

/**
 * M10 — the generation screen.
 *
 * Ask for N questions; duplicates are filtered against the whole bank and any
 * shortfall is topped up, so what appears here is the fresh set. Commit adds
 * the kept questions to a Q Set as active questions — publish the set and they
 * are playable.
 */
export default async function AdminGeneratePage() {
  const user = await getCurrentPageUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") return <ForbiddenCard />;

  const [jobs, categories, stats, aiSettings, sets] = await Promise.all([
    listJobs(30),
    listCategoriesForAdmin(),
    promptVersionStats(),
    getAiGenerationSettings(),
    listSetsForAdmin(),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Generate questions</h1>
          <p className="mt-1 text-sm text-slate-500">
            Ask for N questions, review the fresh batch, then add it to a Q Set in one click.
          </p>
        </div>
        <div className="flex gap-2">
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
        sets={sets.map((set) => ({
          id: set.id,
          title: set.title,
          status: set.status,
          categoryTitle: set.categoryTitle,
        }))}
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
          providerOnly: job.providerOnly,
          providerOrder: job.providerOrder,
          createdAt: job.createdAt,
        }))}
        configured={openRouterKeyConfigured()}
        defaultModel={aiSettings.model}
        categories={categories.map((c) => ({ id: c.id, title: c.title }))}
      />
    </div>
  );
}

/**
 * How is each prompt version doing? Questions asked vs delivered, and how much
 * of the model's output was usable (not a duplicate of something already in the
 * bank). This is the signal for whether a prompt change is an improvement.
 */
function PromptStats({ stats }: { stats: PromptVersionStats[] }) {
  if (stats.length === 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-500">
        No generation results yet — prompt statistics appear here once jobs have run.
      </div>
    );
  }
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-slate-700">Prompt performance</h2>
      <p className="mt-1 text-xs text-slate-400">
        Fresh rate = delivered ÷ (delivered + duplicates filtered). A low rate means the model is
        re-asking facts the bank already covers.
      </p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-left text-xs text-slate-600">
          <thead className="border-b border-slate-200 text-slate-400">
            <tr>
              <th className="py-2 pr-3 font-medium">Prompt</th>
              <th className="py-2 pr-3 font-medium">Jobs</th>
              <th className="py-2 pr-3 font-medium">Asked</th>
              <th className="py-2 pr-3 font-medium">Delivered</th>
              <th className="py-2 pr-3 font-medium">Duplicates</th>
              <th className="py-2 pr-3 font-medium">Fresh rate</th>
            </tr>
          </thead>
          <tbody>
            {stats.map((row) => (
              <tr key={row.promptVersion} className="border-b border-slate-100">
                <td className="py-2 pr-3 font-mono text-[11px] text-slate-700">{row.promptVersion}</td>
                <td className="py-2 pr-3">{row.jobs}</td>
                <td className="py-2 pr-3">{row.requested}</td>
                <td className="py-2 pr-3 text-emerald-600">{row.produced}</td>
                <td className="py-2 pr-3 text-amber-600">{row.duplicates}</td>
                <td className="py-2 pr-3 font-semibold text-slate-800">{pct(row.freshRate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
