import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentPageUser } from "@/lib/server/get-current-user";
import { bindings } from "@/lib/cloudflare/bindings";
import { listCategoriesForAdmin } from "@/modules/catalog";
import { listJobs, openRouterKeyConfigured } from "@/modules/ai";
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

  const [jobs, categories, aiSettings, sets] = await Promise.all([
    listJobs(30),
    listCategoriesForAdmin(),
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
