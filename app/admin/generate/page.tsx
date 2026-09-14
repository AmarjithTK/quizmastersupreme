import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentPageUser } from "@/lib/server/get-current-user";
import { bindings } from "@/lib/cloudflare/bindings";
import { listCategoriesForAdmin } from "@/modules/catalog";
import { listJobs, openRouterKeyConfigured } from "@/modules/ai";
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

  const [jobs, categories] = await Promise.all([
    listJobs(30),
    listCategoriesForAdmin(),
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
