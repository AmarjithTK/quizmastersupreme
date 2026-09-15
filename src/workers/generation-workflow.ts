/**
 * Separate Worker entry: vinext owns the app fetch handler, so this file alone
 * exports the Cloudflare Workflow class. It shares D1/R2 and domain services
 * with the app Worker; Workflow checkpoints are orchestration state, not the
 * source of truth for questions or counters.
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { configuredProvider, getJob, planGenerationJob, r2RawStorage, runGenerationStep } from "@/modules/ai";
import { logException, logInfo, logWarn } from "@/lib/logger";

type Params = { jobId: string };
type WorkflowRuntimeEnv = {
  GENERATION_WORKFLOW: Workflow;
  GENERATION_ORCHESTRATION_TOKEN: string;
  DB: D1Database;
  STORAGE: R2Bucket;
  OPENROUTER_API_KEY: string;
};
const TERMINAL = new Set(["succeeded", "partial", "failed", "cancelled"]);
const STEP_OPTIONS = { retries: { limit: 2, delay: "16 minutes", backoff: "constant" }, timeout: "14 minutes" } as const;

export class GenerationWorkflow extends WorkflowEntrypoint<WorkflowRuntimeEnv, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const jobId = event.payload.jobId;
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(jobId)) throw new Error("Invalid generation job ID.");

    await step.do("build approved blueprint", { retries: { limit: 2, delay: "30 seconds", backoff: "linear" }, timeout: "14 minutes" }, async () => {
      const job = await getJob(jobId);
      if (TERMINAL.has(job.status) || job.blueprintJson) return { revision: job.planRevision, phase: job.phase };
      const planned = await planGenerationJob(job, { provider: configuredProvider(), storage: r2RawStorage() });
      logInfo("workflow", "plan.created", { jobId, revision: planned.planRevision, hash: planned.blueprintHash });
      return { revision: planned.planRevision, phase: planned.phase };
    });

    const beforeApproval = await getJob(jobId);
    if (!TERMINAL.has(beforeApproval.status) && !beforeApproval.planApprovedAt) {
      await step.waitForEvent("await administrator approval", { type: "plan-approved", timeout: "365 days" });
    }

    for (let index = 1; index <= 110; index++) {
      const progress = await step.do(`generation round ${index}`, STEP_OPTIONS, async () => {
        const current = await getJob(jobId);
        if (TERMINAL.has(current.status)) return { done: true, status: current.status, round: current.backfillRound };
        if (!current.planApprovedAt) throw new Error("Generation plan is not approved.");
        const next = await runGenerationStep(jobId, { provider: configuredProvider(), storage: r2RawStorage() });
        logInfo("workflow", "batch.reconciled", {
          jobId, round: next.round, status: next.status, accepted: next.acceptedCount,
          raw: next.rawItemCount, schemaInvalid: next.schemaInvalidCount,
          contentInvalid: next.contentInvalidCount, policyRejected: next.policyRejectedCount,
        });
        return { done: next.done, status: next.status, round: next.round };
      });
      if (progress.done) {
        logInfo("workflow", "job.stopped", { jobId, status: progress.status, round: progress.round });
        return progress;
      }
    }
    throw new Error(`Generation loop exceeded its hard orchestration bound for ${jobId}.`);
  }
}

/** Private service-binding API; the Worker has no public route/workers.dev. */
export default {
  async fetch(request: Request, env: WorkflowRuntimeEnv): Promise<Response> {
    const token = request.headers.get("x-generation-orchestration-token");
    if (!env.GENERATION_ORCHESTRATION_TOKEN || token !== env.GENERATION_ORCHESTRATION_TOKEN) {
      return new Response("Unauthorized", { status: 401 });
    }
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const path = new URL(request.url).pathname.match(/^\/(start|approve|recover|cancel)\/([a-zA-Z0-9_-]{1,100})$/);
    if (!path) return new Response("Not found", { status: 404 });
    const action = path[1]!;
    const jobId = path[2]!;
    try {
      const job = await getJob(jobId);
      if (action === "start") {
        if (TERMINAL.has(job.status)) return Response.json({ status: "complete" });
        try {
          await env.GENERATION_WORKFLOW.create({ id: jobId, params: { jobId } });
        } catch (error) {
          // A repeated start after a lost HTTP response must not create a
          // second orchestrator. Inspect the existing instance instead.
          logWarn("workflow", "start found existing instance", { jobId, message: (error as Error)?.message });
          const existing = await env.GENERATION_WORKFLOW.get(jobId);
          const status = await existing.status();
          if (status.status === "errored" || status.status === "terminated") await existing.restart();
        }
      } else {
        const instance = await env.GENERATION_WORKFLOW.get(jobId);
        const status = await instance.status();
        if (action === "approve" && !TERMINAL.has(job.status)) {
          if (job.planApprovedAt == null) return new Response("Plan is not approved", { status: 409 });
          if (status.status === "errored" || status.status === "terminated" || status.status === "complete") {
            await instance.restart();
          } else {
            await instance.sendEvent({ type: "plan-approved", payload: { revision: job.planRevision } });
          }
        } else if (action === "recover" && !TERMINAL.has(job.status)) {
          if (["errored", "terminated", "complete"].includes(status.status)) await instance.restart();
          else if (status.status === "paused") await instance.resume();
          else if (status.status === "waiting" && job.planApprovedAt != null) {
            await instance.sendEvent({ type: "plan-approved", payload: { revision: job.planRevision } });
          }
        } else if (action === "cancel" && job.status === "cancelled" &&
          ["queued", "running", "waiting", "paused"].includes(status.status)) {
          await instance.terminate();
        }
      }
      const instance = await env.GENERATION_WORKFLOW.get(jobId);
      return Response.json({ id: instance.id, status: await instance.status() });
    } catch (error) {
      logException("workflow", `${action} failed for ${jobId}`, error);
      return Response.json({ error: "Workflow operation failed" }, { status: 500 });
    }
  },
};
