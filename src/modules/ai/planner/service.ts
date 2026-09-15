import { and, desc, eq, isNull, lt, or } from "drizzle-orm";
import { db } from "@/db/client";
import {
  aiGenerationJobs,
  aiGenerationSegments,
  categories,
  quizSets,
  newId,
  nowMs,
  type AiGenerationJob,
  type AiGenerationSegment,
} from "@/db/schema";
import { recordAudit } from "@/modules/audit";
import { sha256Hex } from "@/lib/crypto";
import { conflict, validationError } from "@/lib/errors";
import { estimateCostUsd, estimateJobCostUsd, type LlmProvider } from "../provider";
import { getGenerationSettings } from "@/modules/settings";
import { GENERATION_BLUEPRINT_JSON_SCHEMA, GenerationBlueprintSchema, canonicalizeBlueprint, type GenerationBlueprint } from "./schema";
import { buildPlannerPrompt, PLANNER_PROMPT_VERSION } from "./prompt";

export type PlannerStorage = { put(key: string, value: string): Promise<void> };
export type PlannerDeps = { provider: LlmProvider; storage: PlannerStorage };
const PLANNER_LEASE_MS = 15 * 60 * 1000;

async function claimPlannerLease(job: AiGenerationJob): Promise<string> {
  if (job.backfillRound > 0 || job.committedAt != null || ["succeeded", "partial", "failed", "cancelled"].includes(job.status)) {
    throw conflict("A finished, started, or committed job cannot be re-planned.");
  }
  const token = crypto.randomUUID();
  const now = nowMs();
  await db().update(aiGenerationJobs).set({
    leaseToken: token,
    leaseExpiresAt: now + PLANNER_LEASE_MS,
    phase: "planning",
  }).where(and(
    eq(aiGenerationJobs.id, job.id),
    eq(aiGenerationJobs.planRevision, job.planRevision),
    eq(aiGenerationJobs.backfillRound, 0),
    isNull(aiGenerationJobs.committedAt),
    or(isNull(aiGenerationJobs.leaseToken), isNull(aiGenerationJobs.leaseExpiresAt), lt(aiGenerationJobs.leaseExpiresAt, now)),
  ));
  const current = (await db().select().from(aiGenerationJobs).where(eq(aiGenerationJobs.id, job.id)).limit(1))[0];
  if (current?.leaseToken !== token) throw conflict("Another plan operation is already running.");
  return token;
}

async function releasePlannerLease(job: AiGenerationJob, token: string): Promise<void> {
  const current = (await db().select({
    leaseToken: aiGenerationJobs.leaseToken,
    phase: aiGenerationJobs.phase,
  }).from(aiGenerationJobs).where(eq(aiGenerationJobs.id, job.id)).limit(1))[0];
  if (current?.leaseToken !== token) return;
  await db().update(aiGenerationJobs).set({
    leaseToken: null,
    leaseExpiresAt: null,
    phase: current.phase === "planning" ? job.phase : current.phase,
  }).where(and(eq(aiGenerationJobs.id, job.id), eq(aiGenerationJobs.leaseToken, token)));
}

async function assertPlannerLease(jobId: string, token: string): Promise<void> {
  const current = (await db().select({
    leaseToken: aiGenerationJobs.leaseToken,
    status: aiGenerationJobs.status,
  }).from(aiGenerationJobs).where(eq(aiGenerationJobs.id, jobId)).limit(1))[0];
  if (current?.leaseToken !== token || current.status === "cancelled") {
    throw conflict("The planning lease was lost; this late plan will not be applied.");
  }
}

function parsePlannerJson(text: string): GenerationBlueprint {
  const cleaned = text.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/i, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  const candidate = start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;
  let value: unknown;
  try {
    value = JSON.parse(candidate);
  } catch {
    throw validationError("The planning model did not return valid JSON.");
  }
  const parsed = GenerationBlueprintSchema.safeParse(value);
  if (!parsed.success) {
    const reasons = parsed.error.issues.slice(0, 8).map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw validationError(`The generation plan was invalid: ${reasons.join("; ")}`);
  }
  return parsed.data;
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

async function persistBlueprint(input: {
  job: AiGenerationJob;
  blueprint: GenerationBlueprint;
  actorId: string;
  rawResponseKey?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  plannerCostUsd?: number | null;
  leaseToken: string;
  groundingMode?: "off" | "single" | null;
}): Promise<AiGenerationJob> {
  await assertPlannerLease(input.job.id, input.leaseToken);
  const revision = input.job.planRevision + 1;
  const canonical = canonicalizeBlueprint(input.blueprint, input.job.requestedCount, todayUtc());
  const json = JSON.stringify(canonical);
  const hash = await sha256Hex(json);
  const now = nowMs();

  for (const segment of canonical.segments) {
    await db().insert(aiGenerationSegments).values({
      id: newId(),
      jobId: input.job.id,
      planRevision: revision,
      key: segment.id,
      label: segment.label,
      intent: segment.intent,
      targetCount: segment.targetCount,
      priority: segment.priority,
      acceptedCount: 0,
      rejectedCount: 0,
      invalidCount: 0,
      sourceFactCount: 0,
      policyJson: JSON.stringify({
        allowedAngles: segment.allowedAngles,
        forbiddenAngles: segment.forbiddenAngles,
        entityPolicy: segment.entityPolicy,
      }),
      sourceQueriesJson: JSON.stringify(segment.sourceQueries),
      sourceRequirementsJson: JSON.stringify(segment.sourceRequirements),
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });
  }

  await assertPlannerLease(input.job.id, input.leaseToken);
  await db().update(aiGenerationJobs).set({
    phase: "awaiting_approval",
    plannerVersion: PLANNER_PROMPT_VERSION,
    planRevision: revision,
    blueprintJson: json,
    blueprintHash: hash,
    planApprovedBy: null,
    planApprovedAt: null,
    plannerPromptTokens: input.promptTokens ?? null,
    plannerCompletionTokens: input.completionTokens ?? null,
    plannerCostUsd: input.plannerCostUsd ?? null,
    plannerRawResponseKey: input.rawResponseKey ?? null,
    ...(input.groundingMode ? { groundingMode: input.groundingMode } : {}),
    errorCode: null,
    errorMessage: null,
  }).where(and(eq(aiGenerationJobs.id, input.job.id), eq(aiGenerationJobs.leaseToken, input.leaseToken)));

  await recordAudit(input.actorId, "ai.plan_created", "ai_job", input.job.id, null, {
    revision,
    blueprintHash: hash,
    segments: canonical.segments.length,
    blockingWarnings: canonical.interpretation.ambiguityWarnings.filter((warning) => warning.blocking).length,
  });

  return (await db().select().from(aiGenerationJobs).where(eq(aiGenerationJobs.id, input.job.id)).limit(1))[0]!;
}

export async function planGenerationJob(job: AiGenerationJob, deps: PlannerDeps): Promise<AiGenerationJob> {
  const token = await claimPlannerLease(job);
  try {
    const asOfDate = todayUtc();
    const [category, set, generationSettings] = await Promise.all([
      job.targetCategoryId
        ? db().select({ title: categories.title }).from(categories).where(eq(categories.id, job.targetCategoryId)).limit(1)
        : Promise.resolve([]),
      job.targetSetId
        ? db().select({ title: quizSets.title, mode: quizSets.mode }).from(quizSets).where(eq(quizSets.id, job.targetSetId)).limit(1)
        : Promise.resolve([]),
      getGenerationSettings(),
    ]);
    const prompt = buildPlannerPrompt({
      job,
      asOfDate,
      categoryTitle: category[0]?.title ?? null,
      setTitle: set[0]?.title ?? null,
      setMode: set[0]?.mode ?? null,
      groundingMode: job.groundingMode ?? generationSettings.groundingMode,
      costEstimateUsd: estimateJobCostUsd(job.requestedCount, job.batchSize, job.model),
      hardLimit: generationSettings.maxRequested,
    });
    const response = await deps.provider.generate({
      model: job.model,
      system: prompt.system,
      user: prompt.user,
      temperature: 0.15,
      maxTokens: 8_000,
      responseSchema: {
        name: "generation_blueprint",
        schema: GENERATION_BLUEPRINT_JSON_SCHEMA,
        strict: true,
      },
      providerOnly: job.providerOnly ? JSON.parse(job.providerOnly) : undefined,
      providerOrder: job.providerOrder ? JSON.parse(job.providerOrder) : undefined,
    });
    await assertPlannerLease(job.id, token);
    const nextRevision = job.planRevision + 1;
    const rawResponseKey = `ai-jobs/${job.id}/plan-r${nextRevision}.json`;
    await deps.storage.put(rawResponseKey, JSON.stringify({ request: prompt, response: response.raw }));
    const blueprint = parsePlannerJson(response.text);
    await persistBlueprint({
      job,
      blueprint,
      actorId: job.createdBy,
      leaseToken: token,
      rawResponseKey,
      promptTokens: response.promptTokens,
      completionTokens: response.completionTokens,
      plannerCostUsd: estimateCostUsd(job.model, response.promptTokens, response.completionTokens),
    });
  } finally {
    await releasePlannerLease(job, token);
  }
  return (await db().select().from(aiGenerationJobs).where(eq(aiGenerationJobs.id, job.id)).limit(1))[0]!;
}

export async function saveGenerationPlan(
  job: AiGenerationJob,
  value: unknown,
  actorId: string,
  groundingMode?: "off" | "single" | null,
): Promise<AiGenerationJob> {
  if (job.backfillRound > 0 || job.committedAt != null) throw conflict("A started or committed job cannot be re-planned.");
  const parsed = GenerationBlueprintSchema.safeParse(value);
  if (!parsed.success) throw validationError(`Invalid generation plan: ${parsed.error.issues[0]?.message ?? "unknown error"}`);
  const token = await claimPlannerLease(job);
  try {
    await persistBlueprint({ job, blueprint: parsed.data, actorId, leaseToken: token, groundingMode });
  } finally {
    await releasePlannerLease(job, token);
  }
  return (await db().select().from(aiGenerationJobs).where(eq(aiGenerationJobs.id, job.id)).limit(1))[0]!;
}

export function blueprintOf(job: AiGenerationJob): GenerationBlueprint | null {
  if (!job.blueprintJson) return null;
  try {
    const parsed = GenerationBlueprintSchema.safeParse(JSON.parse(job.blueprintJson));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function approveGenerationPlan(job: AiGenerationJob, actorId: string): Promise<AiGenerationJob> {
  if (job.phase !== "awaiting_approval" || job.backfillRound > 0 || job.committedAt != null || (job.leaseToken && (job.leaseExpiresAt ?? 0) > nowMs())) {
    throw conflict("This plan is not available for approval.");
  }
  const blueprint = blueprintOf(job);
  if (!blueprint) throw validationError("Build a valid generation plan first.");
  const blocking = blueprint.interpretation.ambiguityWarnings.filter((warning) => warning.blocking);
  if (blocking.length > 0) {
    throw validationError(`Resolve the blocking plan warning first: ${blocking[0]!.message}`);
  }
  await db().update(aiGenerationJobs).set({
    phase: "grounding",
    status: "queued",
    planApprovedBy: actorId,
    planApprovedAt: nowMs(),
    errorCode: null,
    errorMessage: null,
  }).where(eq(aiGenerationJobs.id, job.id));
  await recordAudit(actorId, "ai.plan_approved", "ai_job", job.id, null, { revision: job.planRevision });
  return (await db().select().from(aiGenerationJobs).where(eq(aiGenerationJobs.id, job.id)).limit(1))[0]!;
}

export async function listGenerationSegments(jobId: string, revision?: number): Promise<AiGenerationSegment[]> {
  const filters = [eq(aiGenerationSegments.jobId, jobId)];
  if (revision != null) filters.push(eq(aiGenerationSegments.planRevision, revision));
  return db().select().from(aiGenerationSegments).where(and(...filters)).orderBy(desc(aiGenerationSegments.priority));
}
