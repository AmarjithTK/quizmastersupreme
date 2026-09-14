import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentPageUser } from "@/lib/server/get-current-user";
import { AiSettingsPanel } from "@/components/admin/AiSettingsPanel";
import { ForbiddenCard } from "@/components/admin/forbidden";
import {
  AI_MODEL_PRESETS,
  AI_PROVIDERS,
  DEFAULT_AI_MODEL,
  getAiGenerationSettings,
  getProviderRouting,
} from "@/modules/settings";

export const dynamic = "force-dynamic";
export const metadata = { title: "Settings · Admin" };

/**
 * Admin settings (M10+): AI generation provider + default model.
 */
export default async function AdminSettingsPage() {
  const user = await getCurrentPageUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") return <ForbiddenCard />;

  const [settings, routing] = await Promise.all([
    getAiGenerationSettings(),
    getProviderRouting(),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
          <p className="mt-1 text-sm text-slate-500">
            Generation defaults — provider and model for new AI jobs.
          </p>
        </div>
        <Link
          href="/admin"
          className="rounded-lg px-3 py-1.5 text-sm font-medium text-slate-500 hover:bg-slate-100"
        >
          ← Admin
        </Link>
      </header>

      <AiSettingsPanel
        initial={settings}
        initialRouting={routing}
        providers={[...AI_PROVIDERS]}
        modelPresets={[...AI_MODEL_PRESETS]}
      />

      <p className="text-xs text-slate-400">
        Fallback when nothing is stored: {DEFAULT_AI_MODEL}
      </p>
    </div>
  );
}