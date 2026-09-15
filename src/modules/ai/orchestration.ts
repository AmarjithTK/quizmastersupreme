import { bindings } from "@/lib/cloudflare/bindings";
import { logWarn } from "@/lib/logger";
import { sendWorkflowAction, type WorkflowAction } from "./orchestration-core";

export type OrchestrationMode = "workflow" | "manual";
export type { WorkflowAction } from "./orchestration-core";

/** Local dev intentionally uses the browser-driven leased loop. */
export function workflowConfigured(): boolean {
  const env = bindings();
  const deployed = ["production", "staging"].includes(env.APP_ENV as string);
  return deployed && Boolean(env.GENERATION_ORCHESTRATION_TOKEN) && Boolean(env.GENERATION_ORCHESTRATOR);
}

/** Idempotent private dispatch; callers can fall back to visible manual recovery. */
export async function dispatchGenerationWorkflow(action: WorkflowAction, jobId: string): Promise<boolean> {
  if (!workflowConfigured()) return false;
  const env = bindings();
  try {
    const accepted = await sendWorkflowAction(env.GENERATION_ORCHESTRATOR, env.GENERATION_ORCHESTRATION_TOKEN!, action, jobId);
    if (!accepted) {
      logWarn("orchestration", "Workflow dispatch rejected", { action, jobId });
      return false;
    }
    return true;
  } catch (error) {
    logWarn("orchestration", "Workflow dispatch failed", { action, jobId, message: (error as Error)?.message });
    return false;
  }
}
