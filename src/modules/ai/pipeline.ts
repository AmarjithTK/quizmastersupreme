/**
 * AI generation pipeline — the revamped "ask for N, get N" method.
 * REVAMP-PLAN.md §3.
 *
 * TRANSPORT: deliberately queue-agnostic. `runGenerationStep()` is a plain
 * async function; something else decides when to call it. Each call performs AT
 * MOST ONE model request, so no single request owns a whole job and a closed
 * browser loses nothing — every round is persisted in D1 (job counters +
 * working set) and R2 (the raw model response).
 *
 * THE CONTRACT:
 *   POST create job (queued) → step → step → … → terminal
 *   Each step runs one round: ask the model for the shortfall, validate, compare
 *   against the WHOLE bank, and store everything — duplicates included, marked
 *   `rejected` by default with the question they matched. If the model returned
 *   fewer questions than asked, the next round asks for the remainder with the
 *   already-produced stems appended to the digest, so it cannot re-ask them.
 *
 * BUDGET: the request is sized from the count and the model's real output
 * ceiling (`budget.ts`) — not a hard-coded 8000 tokens. DeepSeek V4.1 Flash
 * therefore delivers a 50-question batch in one call.
 *
 * NOTHING here writes to `questions`. Promotion happens only in
 * `commitJobToSet()` — an explicit admin action — which inserts the kept set
 * through `createQuestion()` (the same validation + dedupe funnel as any other
 * write path) as `active` questions.
 */

import { and, desc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { db } from "@/db/client";
import {
  aiCandidates,
  aiGenerationBatches,
  aiGenerationRejections,
  aiGenerationJobs,
  aiGenerationSegments,
  aiSourceFacts,
  newId,
  nowMs,
  type AiCandidate,
  type AiGenerationBatch,
  type AiGenerationJob,
  type QuestionStatus,
} from "@/db/schema";
import { conflict, notFound, validationError } from "@/lib/errors";
import { sha256Hex } from "@/lib/crypto";
import { recordAudit } from "@/modules/audit";
import { logError, logInfo, logWarn, logException } from "@/lib/logger";
import { checkCandidates } from "@/modules/dedupe";
import { computeDedupeHashes, createQuestion, validateQuestion, type QuestionDraft } from "@/modules/questions";
import { getDedupeThresholds, getGenerationSettings } from "@/modules/settings";
import {
  GenerationParseError,
  parseGenerationResponse,
  type ParsedCandidate,
} from "./parse";
import { buildSystemPrompt, buildUserPrompt, PROMPT_VERSION } from "./prompts/generate";
import { estimateCostUsd, LlmError, type LlmProvider } from "./provider";
import { outputBudgetFor } from "./budget";
import { buildCoverageDigest, extractConceptKey, estimateTokens } from "./coverage";
import { generationResponseJsonSchema } from "./schema";
import { allocateBatchDirective, blueprintOf, listGenerationSegments } from "./planner";
import { checkCandidatePolicy } from "./quality";
import { reconcileFunnel } from "./reconciliation";
import {
  buildSourcePool,
  renderSourcePool,
  type GroundingMode,
  type GroundingSettings,
  type SourcePool,
} from "@/modules/grounding";

const MAX_BOUND_PARAMS = 90;
/**
 * Absolute ceiling, independent of settings — the last line of defence against
 * a bad settings row. The effective ceiling is `generation.max_requested`.
 */
export const MAX_REQUESTED_HARD = 1000;
/** Token budget for the job-local "already generated" concept block. */
const JOB_CONCEPTS_MAX_TOKENS = 1200;
/** Two consecutive batches below this acceptance rate = the topic is saturated. */
const SATURATION_RATE = 0.25;
/** Long enough for the slowest observed provider call; expired work is recoverable. */
const STEP_LEASE_MS = 15 * 60 * 1000;

export type RawStorage = {
  put(key: string, value: string): Promise<void>;
  get(key: string): Promise<string | null>;
};

export type GenerationDeps = {
  provider: LlmProvider;
  storage: RawStorage;
  /**
   * Provider for the grounding research call. Defaults to `provider`; injected
   * so tests can ground with a stub and no network.
   */
  groundingProvider?: LlmProvider;
  /** Cost estimator, injectable for tests. */
  estimateCostUsd?: typeof estimateCostUsd;
};

export type JobProgress = {
  jobId: string;
  status: string;
  phase: string | null;
  /** THE target: clean questions the job is driving for. */
  requestedCount: number;
  /** Clean questions accepted so far — the number the loop drives on. */
  acceptedCount: number;
  /** Everything stored, including duplicates that arrived rejected. */
  producedCount: number;
  validCount: number;
  /** Questions stored but rejected by default (duplicates). */
  duplicateCount: number;
  rawItemCount: number;
  modelShortfallCount: number;
  schemaInvalidCount: number;
  contentInvalidCount: number;
  policyRejectedCount: number;
  /** Model calls made so far (1-based once the first has run). */
  round: number;
  /** Planned number of calls at the current batch size. */
  totalPlannedCalls: number;
  /** Questions per internal call for this job. */
  batchSize: number;
  /** What the one-off web grounding cost, if it ran. */
  groundingCostUsd: number | null;
  groundingCached: boolean;
  /** True once the job can advance no further without an admin action. */
  done: boolean;
  error: string | null;
};

export type CreateJobInput = {
  topic: string;
  brief: string;
  requestedCount: number;
  /** Per-job override of the global batch size (5–50). */
  batchSize?: number | null;
  /** Per-job override of the call cap. */
  maxCalls?: number | null;
  /** Per-job override of the global grounding mode. */
  groundingMode?: GroundingMode | null;
  difficulty?: string | null;
  subtopics?: string[] | null;
  avoidTopics?: string[] | null;
  model: string;
  targetCategoryId?: string | null;
  targetSetId?: string | null;
  temperature?: number | null;
  includeExamples?: boolean;
  /** OpenRouter provider slugs — allow-list (only) and priority (order). */
  providerOnly?: string[] | null;
  providerOrder?: string[] | null;
  /** Who/what the questions are for (audience or exam). */
  target?: string | null;
  /** Authoritative references the model must stay within. */
  sources?: string | null;
  /** API routes enable planning; tests/legacy internal callers may opt out. */
  planningEnabled?: boolean;
};

/** Deterministic slug validation: non-empty, alphanumerics + dash/underscore. */
function normalizeProviderSlugs(raw: string[] | null | undefined): string[] | null {
  if (!raw || raw.length === 0) return null;
  const slugs = [...new Set(raw.map((slug) => slug.trim()).filter(Boolean))];
  for (const slug of slugs) {
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(slug)) {
      throw validationError(`Invalid provider slug "${slug}". Use OpenRouter slugs like "together", "deepinfra".`);
    }
  }
  return slugs.length > 0 ? slugs : null;
}

function parseJsonArray(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as string[]) : null;
  } catch {
    return null;
  }
}

// ── job lifecycle ────────────────────────────────────────────────────────────

export async function createGenerationJob(
  input: CreateJobInput,
  actorId: string,
): Promise<AiGenerationJob> {
  const settings = await getGenerationSettings();

  const topic = input.topic.trim();
  if (!topic) throw validationError("A topic is required.");
  if (!input.brief.trim()) throw validationError("A brief is required.");
  if (!Number.isInteger(input.requestedCount) || input.requestedCount < 1) {
    throw validationError("Request at least one question.");
  }
  // The effective ceiling is the admin setting; the hard constant is a backstop.
  const ceiling = Math.min(settings.maxRequested, MAX_REQUESTED_HARD);
  if (input.requestedCount > ceiling) {
    throw validationError(`Request at most ${ceiling} questions per job.`);
  }
  if (!input.model.trim()) throw validationError("A model is required.");

  // Batch size is a per-job override of the global default, clamped to sanity.
  const batchSize = Math.min(
    Math.max(input.batchSize ?? settings.batchSize, 5),
    Math.max(5, Math.min(50, settings.batchSize * 2)),
  );
  // Enough calls for the planned batches plus ~40% refill slack.
  const plannedCalls = Math.ceil(input.requestedCount / batchSize);
  const maxCalls = Math.min(
    100,
    Math.max(input.maxCalls ?? 0, Math.ceil(plannedCalls * 1.4) + 1),
  );

  // Compress what the bank already covers for this topic, so the model does not
  // re-ask facts we already have. A stateless API has no other memory (§12.4).
  const digest = await buildCoverageDigest({
    topic,
    subtopics: input.subtopics ?? null,
    includeExamples: input.includeExamples ?? false,
  });

  const now = nowMs();
  const row: AiGenerationJob = {
    id: newId(),
    createdBy: actorId,
    targetCategoryId: input.targetCategoryId ?? null,
    targetSetId: input.targetSetId ?? null,
    brief: input.brief.trim(),
    topic,
    subtopics: input.subtopics?.length ? JSON.stringify(input.subtopics) : null,
    difficulty: input.difficulty ?? null,
    requestedCount: input.requestedCount,
    avoidTopics: input.avoidTopics?.length ? JSON.stringify(input.avoidTopics) : null,
    providerOnly: normalizeProviderSlugs(input.providerOnly)
      ? JSON.stringify(normalizeProviderSlugs(input.providerOnly))
      : null,
    providerOrder: normalizeProviderSlugs(input.providerOrder)
      ? JSON.stringify(normalizeProviderSlugs(input.providerOrder))
      : null,
    target: input.target?.trim() || null,
    sources: input.sources?.trim() || null,
    committedSetId: null,
    committedAt: null,
    provider: "openrouter",
    model: input.model.trim(),
    temperature: input.temperature ?? null,
    promptVersion: PROMPT_VERSION,
    phase: input.planningEnabled ? "planning" : "generating",
    plannerVersion: null,
    planRevision: 0,
    blueprintJson: null,
    blueprintHash: null,
    planApprovedBy: null,
    planApprovedAt: null,
    plannerPromptTokens: null,
    plannerCompletionTokens: null,
    plannerCostUsd: null,
    plannerRawResponseKey: null,
    coverageDigest: digest.text || null,
    coverageTokens: digest.estimatedTokens,
    includeExamples: input.includeExamples ? 1 : 0,
    status: "queued",
    producedCount: 0,
    validCount: 0,
    duplicateCount: 0,
    backfillRound: 0,
    duplicateSkipped: 0,
    rawItemCount: 0,
    modelShortfallCount: 0,
    schemaInvalidCount: 0,
    contentInvalidCount: 0,
    policyRejectedCount: 0,
    leaseToken: null,
    leaseExpiresAt: null,
    acceptedCount: 0,
    batchSize,
    maxCalls,
    coveredConcepts: null,
    // The source pool is filled by the first step (grounding is a slow call, so
    // it must not run inside the create request).
    sourcePool: null,
    groundingMode: input.groundingMode ?? null,
    groundingCostUsd: null,
    groundingCached: 0,
    groundingAt: null,
    groundingError: null,
    promptTokens: null,
    completionTokens: null,
    costUsd: null,
    durationMs: null,
    rawResponseKey: null,
    errorCode: null,
    errorMessage: null,
    createdAt: now,
    startedAt: null,
    finishedAt: null,
  };

  await db().insert(aiGenerationJobs).values(row);
  logInfo("ai", `job ${row.id} created`, {
    topic: row.topic,
    model: row.model,
    requestedCount: row.requestedCount,
    batchSize: row.batchSize,
    maxCalls: row.maxCalls,
    actorId,
    coverageQuestions: digest.questionCount,
    coverageConcepts: digest.conceptCount,
    coverageTokens: digest.estimatedTokens,
  });
  await recordAudit(actorId, "ai.job_create", "ai_job", row.id, null, {
    topic: row.topic,
    requestedCount: row.requestedCount,
    batchSize: row.batchSize,
    maxCalls: row.maxCalls,
    model: row.model,
  });

  return row;
}

export async function getJob(jobId: string): Promise<AiGenerationJob> {
  const row = (await db().select().from(aiGenerationJobs).where(eq(aiGenerationJobs.id, jobId)).limit(1))[0];
  if (!row) throw notFound("Generation job not found.");
  return row;
}

export async function listJobs(limit = 20): Promise<AiGenerationJob[]> {
  return db()
    .select()
    .from(aiGenerationJobs)
    .orderBy(desc(aiGenerationJobs.createdAt))
    .limit(Math.min(100, Math.max(1, limit)));
}

export async function cancelJob(jobId: string, actorId: string): Promise<AiGenerationJob> {
  const job = await getJob(jobId);
  if (TERMINAL_STATUSES.includes(job.status)) {
    throw conflict("That job has already finished.");
  }
  await db()
    .update(aiGenerationJobs)
    .set({ status: "cancelled", phase: "reviewable", leaseToken: null, leaseExpiresAt: null, finishedAt: nowMs() })
    .where(eq(aiGenerationJobs.id, jobId));
  await db().update(aiGenerationBatches).set({
    status: "failed",
    errorCode: "CANCELLED",
    errorMessage: "The job was cancelled while this request was in flight.",
    finishedAt: nowMs(),
  }).where(and(eq(aiGenerationBatches.jobId, jobId), eq(aiGenerationBatches.status, "running")));
  await recordAudit(actorId, "ai.job_cancel", "ai_job", jobId);
  return getJob(jobId);
}

const TERMINAL_STATUSES = ["succeeded", "partial", "failed", "cancelled"];

function progressOf(job: AiGenerationJob, error: string | null = null): JobProgress {
  return {
    jobId: job.id,
    status: job.status,
    phase: job.phase,
    requestedCount: job.requestedCount,
    acceptedCount: job.acceptedCount,
    producedCount: job.producedCount,
    validCount: job.validCount,
    duplicateCount: job.duplicateCount,
    rawItemCount: job.rawItemCount,
    modelShortfallCount: job.modelShortfallCount,
    schemaInvalidCount: job.schemaInvalidCount,
    contentInvalidCount: job.contentInvalidCount,
    policyRejectedCount: job.policyRejectedCount,
    round: job.backfillRound,
    totalPlannedCalls: Math.max(1, Math.ceil(job.requestedCount / Math.max(1, job.batchSize))),
    batchSize: job.batchSize,
    groundingCostUsd: job.groundingCostUsd,
    groundingCached: job.groundingCached === 1,
    done: TERMINAL_STATUSES.includes(job.status),
    error,
  };
}

// ── the generation rounds ────────────────────────────────────────────────────

/**
 * Advance a job by exactly ONE model round. Safe to call repeatedly: a terminal
 * job is returned unchanged, so a retry or a double-click cannot double-generate.
 */
export async function runGenerationStep(
  jobId: string,
  deps: GenerationDeps,
): Promise<JobProgress> {
  const job = await getJob(jobId);
  logInfo("ai", `runGenerationStep ${jobId}`, {
    status: job.status,
    round: job.backfillRound,
    produced: job.producedCount,
    requested: job.requestedCount,
  });

  if (TERMINAL_STATUSES.includes(job.status)) {
    logWarn("ai", `step called on terminal job ${jobId}`, { status: job.status });
    return progressOf(job);
  }
  if (job.committedAt != null) throw conflict("This generation job has already been committed.");
  if (job.phase === "planning" || job.phase === "awaiting_approval") {
    throw conflict(job.phase === "planning" ? "Build the generation plan first." : "Approve the generation plan first.");
  }

  const leaseToken = crypto.randomUUID();
  const claimedAt = nowMs();
  await db()
    .update(aiGenerationJobs)
    .set({ leaseToken, leaseExpiresAt: claimedAt + STEP_LEASE_MS })
    .where(
      and(
        eq(aiGenerationJobs.id, jobId),
        inArray(aiGenerationJobs.status, ["queued", "running"]),
        isNull(aiGenerationJobs.committedAt),
        or(isNull(aiGenerationJobs.leaseToken), isNull(aiGenerationJobs.leaseExpiresAt), lt(aiGenerationJobs.leaseExpiresAt, claimedAt)),
      ),
    );
  const claimed = await getJob(jobId);
  if (claimed.leaseToken !== leaseToken) throw conflict("Another generation step is already running.");
  if (TERMINAL_STATUSES.includes(claimed.status) || claimed.committedAt != null || claimed.phase === "awaiting_approval" || claimed.phase === "planning") {
    throw conflict("This job is no longer eligible for generation.");
  }

  // Any running row left by an expired/legacy request is preserved as an
  // interrupted attempt. The next immutable batch number can then retry it.
  await db()
    .update(aiGenerationBatches)
    .set({
      status: "failed",
      errorCode: "INTERRUPTED",
      errorMessage: "The previous request ended before this batch was finalized; it is safe to retry.",
      finishedAt: claimedAt,
    })
    .where(and(eq(aiGenerationBatches.jobId, jobId), eq(aiGenerationBatches.status, "running")));

  try {
    return await generateRound(claimed, deps, leaseToken);
  } finally {
    await db()
      .update(aiGenerationJobs)
      .set({ leaseToken: null, leaseExpiresAt: null })
      .where(and(eq(aiGenerationJobs.id, jobId), eq(aiGenerationJobs.leaseToken, leaseToken)));
  }
}

/**
 * ONE internal batch (one model call): ask for the shortfall (capped at the
 * job's batch size), validate, flag duplicates against the whole bank AND
 * everything this job already produced, store it all, then decide whether the
 * job continues (refill), succeeded, or stopped (saturation / call cap).
 */
async function generateRound(job: AiGenerationJob, deps: GenerationDeps, leaseToken: string): Promise<JobProgress> {
  const settings = await getGenerationSettings();
  const callsMade = job.backfillRound;
  const callNo = callsMade + 1;
  const batchNo = await nextBatchNumber(job.id);
  const shortfall = Math.max(0, job.requestedCount - job.acceptedCount);

  // ── terminal guards ───────────────────────────────────────────────────────
  if (shortfall <= 0) {
    await finishJob(job.id, "succeeded");
    return progressOf(await getJob(job.id));
  }
  if (callsMade >= job.maxCalls) {
    const message = `Reached the ${job.maxCalls}-call limit with ${job.acceptedCount} of ${job.requestedCount} accepted.`;
    await finishJob(job.id, job.acceptedCount > 0 ? "partial" : "failed", "MAX_CALLS", message);
    return progressOf(await getJob(job.id), message);
  }

  // ── how many to ask for ───────────────────────────────────────────────────
  // A full batch, but the final refill never becomes a degenerate 1-question
  // prompt (countMode "exact" is the opt-in exception).
  let ask =
    settings.countMode === "exact"
      ? Math.max(1, Math.min(job.batchSize, shortfall))
      : Math.min(job.batchSize, Math.max(shortfall, settings.minRefill));
  const previousBatch = (await db().select({
    asked: aiGenerationBatches.asked,
    raw: aiGenerationBatches.rawItemCount,
    schemaInvalid: aiGenerationBatches.schemaInvalidCount,
    finishReason: aiGenerationBatches.finishReason,
    status: aiGenerationBatches.status,
  }).from(aiGenerationBatches)
    .where(eq(aiGenerationBatches.jobId, job.id))
    .orderBy(desc(aiGenerationBatches.batchNo)).limit(1))[0];
  const deliveryPoor = previousBatch?.status === "succeeded" &&
    (previousBatch.finishReason === "length" || previousBatch.raw < previousBatch.asked * 0.5);
  if (deliveryPoor) ask = Math.min(ask, Math.max(settings.countMode === "exact" ? 1 : 5, Math.floor(previousBatch.asked / 2)));
  const formatPoor = previousBatch?.status === "succeeded" && previousBatch.raw > 0 &&
    previousBatch.schemaInvalid / previousBatch.raw >= 0.25;

  // ── grounding: ONE research call per job, before the first batch ─────────
  // Billed per request, so it must not run per batch. Failures are recorded,
  // never fatal — the job runs ungrounded.
  const blueprint = blueprintOf(job);
  let segments = blueprint ? await listGenerationSegments(job.id, job.planRevision) : [];
  let groundingCost = job.groundingCostUsd ?? 0;
  let sourcePoolJson = job.sourcePool;
  // `groundingAt` is the paid-attempt marker even if research produced no
  // usable pool. A Workflow retry of the first generation step must not
  // silently buy the same source search again.
  if (callsMade === 0 && !sourcePoolJson && job.groundingAt == null) {
    const mode = (job.groundingMode as GroundingMode | null) ?? settings.groundingMode;
    if (mode !== "off") {
      const groundingSettings: GroundingSettings = {
        mode,
        engine: settings.groundingEngine,
        maxResults: settings.groundingMaxResults,
        ttlDays: settings.groundingTtlDays,
        includeDomains: splitDomains(settings.groundingIncludeDomains),
        excludeDomains: splitDomains(settings.groundingExcludeDomains),
      };

      const grounded = await buildSourcePool(
        {
          topic: job.topic,
          brief: job.brief,
          userSources: job.sources,
          settings: groundingSettings,
          blueprint,
          scopeKey: job.blueprintHash ?? job.brief,
        },
        {
          provider: deps.groundingProvider ?? deps.provider,
          model: job.model,
          estimateCostUsd: deps.estimateCostUsd ?? estimateCostUsd,
        },
      );

      // `groundingCost` (0 on failure) feeds the job total; the stored column
      // stays null when nothing was actually billed.
      groundingCost = grounded.costUsd ?? 0;
      sourcePoolJson = grounded.pool ? JSON.stringify(grounded.pool) : null;

      await db()
        .update(aiGenerationJobs)
        .set({
          sourcePool: sourcePoolJson,
          groundingCostUsd: grounded.costUsd,
          groundingCached: grounded.cached ? 1 : 0,
          groundingAt: nowMs(),
          groundingError: grounded.error,
        })
        .where(eq(aiGenerationJobs.id, job.id));

      logInfo("ai", `grounding for ${job.id}`, {
        mode,
        engine: groundingSettings.engine,
        cached: grounded.cached,
        skipped: grounded.skipped,
        facts: grounded.pool?.extracts.length ?? 0,
        citations: grounded.pool?.citations.length ?? 0,
        costUsd: grounded.costUsd,
        error: grounded.error,
      });

      if (blueprint && grounded.pool) {
        await persistSourceFacts(job.id, segments, grounded.pool);
        segments = await listGenerationSegments(job.id, job.planRevision);
      }
    }
  }

  await assertGenerationLease(job.id, leaseToken);

  const existing = await listJobCandidates(job.id);
  const sourceFacts = blueprint
    ? await db().select().from(aiSourceFacts).where(eq(aiSourceFacts.jobId, job.id))
    : [];
  const directive = blueprint
    ? allocateBatchDirective({
        blueprint,
        segments,
        candidates: existing,
        sourceFacts,
        batchNo,
        ask,
        planRevision: job.planRevision,
      })
    : null;
  const effectiveAsk = directive?.ask ?? ask;
  if (effectiveAsk <= 0) {
    const limited = directive?.sourceLimitedSegmentKeys ?? [];
    const sourceLimited = limited.length > 0 && !directive?.typeCapacityExhausted;
    const code = sourceLimited ? "SOURCE_LIMITED" : "PLAN_EXHAUSTED";
    const message = sourceLimited
      ? `No cited facts are available for required coverage segments: ${limited.join(", ")}. ${job.acceptedCount} of ${job.requestedCount} accepted.`
      : `The approved plan has no remaining allocatable slots (${job.acceptedCount} of ${job.requestedCount} accepted).`;
    await finishJob(job.id, job.acceptedCount > 0 ? "partial" : "failed", code, message);
    return progressOf(await getJob(job.id), message);
  }

  const directiveJson = directive ? JSON.stringify(directive) : null;
  const directiveHash = directiveJson ? await sha256Hex(directiveJson) : null;
  const relevantSourceIds = new Set(directive?.slots.flatMap((slot) => slot.sourceIds) ?? []);
  const relevantFacts = directive
    ? sourceFacts.filter((fact) => relevantSourceIds.has(fact.id))
    : sourceFacts;
  const digest = buildJobDigest(job, sourcePoolJson, !blueprint);
  const system = buildSystemPrompt();
  const user = buildUserPrompt({
    topic: job.topic,
    target: job.target,
    sources: job.sources,
    subtopics: parseJsonArray(job.subtopics),
    difficulty: job.difficulty,
    examBody: null,
    count: effectiveAsk,
    brief: job.brief,
    coverageDigest: digest,
    avoidTopics: parseJsonArray(job.avoidTopics),
    directive,
    sourceFacts: relevantFacts,
    previousFailureHints: await recentFailureHints(job.id),
  });

  const maxTokens = outputBudgetFor(effectiveAsk, job.model);
  const startedAt = nowMs();
  const batchId = newId();
  const requestManifestKey = `ai-jobs/${job.id}/request-r${batchNo}.json`;
  const rawProviderResponseKey = `ai-jobs/${job.id}/provider-r${batchNo}.json`;
  const request = {
    model: job.model,
    system,
    user,
    temperature: formatPoor ? Math.min(job.temperature ?? 0.7, 0.3) : job.temperature ?? 0.7,
    maxTokens,
    responseSchema: {
      name: "generated_questions",
      schema: generationResponseJsonSchema(effectiveAsk, Boolean(blueprint)),
      strict: true,
    },
    providerOnly: parseJsonArray(job.providerOnly) ?? undefined,
    providerOrder: parseJsonArray(job.providerOrder) ?? undefined,
  };

  await assertGenerationLease(job.id, leaseToken);

  await db().insert(aiGenerationBatches).values({
    id: batchId,
    jobId: job.id,
    batchNo,
    status: "running",
    asked: effectiveAsk,
    directiveJson,
    directiveHash,
    planRevision: job.planRevision,
    leaseToken,
    responseFormatMode: "json_schema",
    requestManifestKey,
    rawProviderResponseKey,
    startedAt,
  });
  await db()
    .update(aiGenerationJobs)
    .set({ status: "running", phase: "generating", startedAt: job.startedAt ?? startedAt })
    .where(eq(aiGenerationJobs.id, job.id));

  try {
    await deps.storage.put(requestManifestKey, JSON.stringify({
      jobId: job.id,
      batchId,
      batchNo,
      planRevision: job.planRevision,
      directive,
      request,
      createdAt: startedAt,
    }));
  } catch (error) {
    logException("ai", `could not archive request manifest for ${job.id}`, error);
  }

  logInfo("ai", `batch ${batchNo} for ${job.id}`, {
    model: job.model,
    asking: effectiveAsk,
    shortfall,
    batchSize: job.batchSize,
    maxTokens,
    acceptedSoFar: job.acceptedCount,
    coveredConcepts: parseJsonArray(job.coveredConcepts)?.length ?? 0,
  });

  // ── the model call (one retry when the provider says it is retryable) ─────
  let response;
  let responseFormatMode = "json_schema";
  try {
    const result = await callWithRetry(deps, request, async (fallbackRequest) => {
      await assertGenerationLease(job.id, leaseToken);
      await deps.storage.put(requestManifestKey, JSON.stringify({
        jobId: job.id,
        batchId,
        batchNo,
        planRevision: job.planRevision,
        directive,
        attemptedRequests: [request, fallbackRequest],
        responseFormatMode: "json_object_fallback",
        createdAt: startedAt,
      }));
      await db().update(aiGenerationBatches).set({ responseFormatMode: "json_object_fallback" })
        .where(eq(aiGenerationBatches.id, batchId));
    });
    response = result.response;
    responseFormatMode = result.mode;
  } catch (error) {
    await assertGenerationLease(job.id, leaseToken);
    const message = error instanceof LlmError ? error.message : "The model provider call failed.";
    const code = error instanceof LlmError ? error.code : "PROVIDER_ERROR";
    logException("ai", `batch ${batchNo} FAILED for ${job.id}`, error);
    await failBatch(batchId, startedAt, code, message);
    await bumpCallCount(job.id, callNo);
    const partial = job.producedCount > 0 || job.acceptedCount > 0;
    await finishJob(job.id, partial ? "partial" : "failed", code, message);
    return progressOf(await getJob(job.id), message);
  }

  await assertGenerationLease(job.id, leaseToken);

  const key = `ai-jobs/${job.id}/response-r${batchNo}.txt`;
  try {
    await Promise.all([
      deps.storage.put(key, response.text),
      deps.storage.put(rawProviderResponseKey, safeJson({
        response: response.raw,
        finishReason: response.finishReason ?? null,
        promptTokens: response.promptTokens,
        completionTokens: response.completionTokens,
      })),
    ]);
  } catch (error) {
    // Archiving is diagnostic, not correctness.
    logException("ai", `could not archive raw response for ${job.id}`, error);
  }

  let parsed;
  try {
    parsed = parseGenerationResponse(response.text, job.topic);
  } catch (error) {
    await assertGenerationLease(job.id, leaseToken);
    const message =
      error instanceof GenerationParseError ? error.message : "The model response could not be parsed.";
    logException("ai", `batch ${batchNo} parse failed for ${job.id}`, error);
    const nowFinished = nowMs();
    await db().update(aiGenerationBatches).set({
      status: "failed",
      modelShortfallCount: effectiveAsk,
      finishReason: response.finishReason ?? null,
      promptTokens: response.promptTokens,
      completionTokens: response.completionTokens,
      costUsd: (deps.estimateCostUsd ?? estimateCostUsd)(job.model, response.promptTokens, response.completionTokens),
      durationMs: nowFinished - startedAt,
      rawResponseKey: key,
      errorCode: "UNPARSEABLE",
      errorMessage: message,
      finishedAt: nowFinished,
    }).where(eq(aiGenerationBatches.id, batchId));
    const terminalStatus = job.acceptedCount > 0 ? "partial" : "failed";
    await db().update(aiGenerationJobs).set({
      status: terminalStatus,
      phase: "reviewable",
      backfillRound: callNo,
      modelShortfallCount: job.modelShortfallCount + effectiveAsk,
      promptTokens: (job.promptTokens ?? 0) + (response.promptTokens ?? 0),
      completionTokens: (job.completionTokens ?? 0) + (response.completionTokens ?? 0),
      rawResponseKey: key,
      errorCode: "UNPARSEABLE",
      errorMessage: message,
      finishedAt: nowFinished,
    }).where(eq(aiGenerationJobs.id, job.id));
    return progressOf(await getJob(job.id), message);
  }

  // ── validate individually ─────────────────────────────────────────────────
  const contentValid: ParsedCandidate[] = [];
  const contentRejected: Array<{ candidate: ParsedCandidate; errors: string[] }> = [];
  for (const candidate of parsed.accepted) {
    const { errors } = validateQuestion(candidate.draft);
    if (errors.length === 0) contentValid.push(candidate);
    else contentRejected.push({
      candidate,
      errors: errors.map((issue) => `${issue.field}: ${issue.message}`),
    });
  }

  const validSourceIds = new Set(sourceFacts.map((fact) => fact.id));
  const currentSegmentCounts = new Map<string, number>();
  const currentQuestionTypeCounts = new Map<string, number>();
  const currentEntityCounts = new Map<string, number>();
  const currentFactKeys = new Set<string>();
  const policyOutcomes = contentValid.map((candidate) => {
    const verdict = checkCandidatePolicy({
      draft: candidate.draft,
      metadata: candidate.metadata,
      blueprint,
      segments,
      existing,
      validSourceIds,
      sourceFacts,
      directive,
      currentSegmentCounts,
      currentQuestionTypeCounts,
      currentEntityCounts,
      currentFactKeys,
    });
    if (verdict.accepted) {
      const segment = candidate.metadata.segmentId;
      if (segment) currentSegmentCounts.set(segment, (currentSegmentCounts.get(segment) ?? 0) + 1);
      const questionType = candidate.metadata.questionType;
      if (questionType) currentQuestionTypeCounts.set(questionType, (currentQuestionTypeCounts.get(questionType) ?? 0) + 1);
      const entity = normalizePolicyKey(candidate.metadata.entityKey);
      const fact = normalizePolicyKey(candidate.metadata.factKey);
      if (entity) currentEntityCounts.set(entity, (currentEntityCounts.get(entity) ?? 0) + 1);
      if (fact) currentFactKeys.add(fact);
    }
    return { candidate, verdict };
  });
  const policyValid = policyOutcomes.filter((entry) => entry.verdict.accepted);

  // ── compare against the WHOLE bank + everything this job produced ─────────
  const thresholds = await getDedupeThresholds();
  const verdicts = await checkCandidates(
    policyValid.map(({ candidate }) => ({
      stem: candidate.draft.stem,
      optionBodies: candidate.draft.options.map((option) => option.body),
    })),
    { thresholds },
  );

  const batchHashes = await loadBatchHashes(job.id);
  const now = nowMs();
  let nextIndex = job.producedCount;
  const rows: Array<typeof aiCandidates.$inferInsert> = [];
  const acceptedConcepts: string[] = [];
  let acceptedThisBatch = 0;
  let flagged = 0;
  let verdictIndex = 0;

  for (const { candidate, verdict: policyVerdict } of policyOutcomes) {
    if (!policyVerdict.accepted) {
      rows.push(candidateRow({
        candidate,
        job,
        batchNo,
        batchIndex: nextIndex++,
        createdAt: now,
        rejected: true,
        rejectionKind: "policy",
        rejectionReason: policyVerdict.reason,
      }));
      continue;
    }

    const verdict = verdicts[verdictIndex++]!;
    const mate = batchHashes.get(verdict.normalizedHash);

    let dedupeStatus = verdict.status;
    let matchedQuestionId: string | null = verdict.bestMatch?.questionId ?? null;
    let matchedStem: string | null = verdict.bestMatch?.stem ?? null;
    let similarity: number | null = verdict.bestMatch?.similarity ?? null;
    let reason: string | null = null;
    const percent = (value: number | null) =>
      value == null ? "" : ` (${Math.round(value * 100)}% match)`;

    if (mate) {
      dedupeStatus = "exact_dup";
      matchedQuestionId = null;
      matchedStem = mate.stem;
      similarity = 1;
      reason = `Already produced in this job as Q${(mate.batchIndex ?? 0) + 1}.`;
    } else if (dedupeStatus === "exact_dup") {
      reason = "Identical to a question already in the bank.";
    } else if (dedupeStatus === "near_dup") {
      reason = `Almost certainly a duplicate of an existing bank question${percent(similarity)}.`;
    } else if (dedupeStatus === "possible_dup") {
      reason = `Looks similar to an existing bank question${percent(similarity)} — check it before keeping.`;
    }

    const rejected = dedupeStatus === "clean" ? 0 : 1;
    if (rejected === 1) flagged++;

    const batchIndex = nextIndex++;
    rows.push(candidateRow({
      candidate,
      job,
      batchNo,
      batchIndex,
      createdAt: now,
      rejected: rejected === 1,
      dedupeStatus,
      matchedQuestionId,
      matchedStem,
      similarity,
      dedupeReason: reason,
      rejectionKind: rejected ? "dedupe" : null,
      rejectionReason: rejected ? reason : null,
    }));

    if (rejected === 0) {
      acceptedThisBatch++;
      const answer =
        candidate.draft.options.find((option) => option.key === candidate.draft.correctOptionKey)
          ?.body ?? null;
      const concept = extractConceptKey(candidate.draft.stem, answer);
      if (concept) acceptedConcepts.push(concept);
    }

    batchHashes.set(verdict.normalizedHash, { stem: candidate.draft.stem, batchIndex });
  }

  const rejectionRows: Array<typeof aiGenerationRejections.$inferInsert> = [
    ...parsed.rejected.map((rejection) => ({
      id: newId(), jobId: job.id, batchId, batchNo, modelIndex: rejection.index,
      stage: "schema", code: "SCHEMA_INVALID", reasonsJson: JSON.stringify(rejection.errors),
      rawJson: safeJson(rejection.raw), createdAt: now,
    })),
    ...contentRejected.map(({ candidate, errors }) => ({
      id: newId(), jobId: job.id, batchId, batchNo, modelIndex: candidate.index,
      stage: "content", code: "CONTENT_INVALID", reasonsJson: JSON.stringify(errors),
      rawJson: safeJson(candidate.raw), createdAt: now,
    })),
    ...policyOutcomes.filter((entry) => !entry.verdict.accepted).map(({ candidate, verdict }) => ({
      id: newId(), jobId: job.id, batchId, batchNo, modelIndex: candidate.index,
      stage: "policy", code: verdict.code.toUpperCase(), reasonsJson: JSON.stringify([verdict.reason]),
      rawJson: safeJson(candidate.raw), createdAt: now,
    })),
  ];

  const funnel = reconcileFunnel({
    askedCount: effectiveAsk,
    rawItemCount: parsed.rawItemCount,
    schemaValidCount: parsed.accepted.length,
    schemaInvalidCount: parsed.rejected.length,
    contentValidCount: contentValid.length,
    contentInvalidCount: contentRejected.length,
    policyValidCount: policyValid.length,
    policyRejectedCount: policyOutcomes.length - policyValid.length,
    duplicateFlaggedCount: flagged,
    acceptedCount: acceptedThisBatch,
  });

  await assertGenerationLease(job.id, leaseToken);

  // D1's ~100 bound-parameter ceiling; derive the chunk from the real column count.
  const columnsPerRow = Object.keys(aiCandidates).length;
  const perChunk = Math.max(1, Math.floor(MAX_BOUND_PARAMS / Math.max(1, columnsPerRow)));
  for (let i = 0; i < rows.length; i += perChunk) {
    await db().insert(aiCandidates).values(rows.slice(i, i + perChunk));
  }
  const rejectionColumns = Object.keys(aiGenerationRejections).length;
  const rejectionChunk = Math.max(1, Math.floor(MAX_BOUND_PARAMS / Math.max(1, rejectionColumns)));
  for (let i = 0; i < rejectionRows.length; i += rejectionChunk) {
    await db().insert(aiGenerationRejections).values(rejectionRows.slice(i, i + rejectionChunk));
  }

  if (blueprint) await updateSegmentLedgers(segments, rows, parsed.rejected.length + contentRejected.length);

  const produced = job.producedCount + rows.length;
  const acceptedTotal = job.acceptedCount + acceptedThisBatch;
  const duplicateTotal = job.duplicateCount + flagged;
  const promptTokens = (job.promptTokens ?? 0) + (response.promptTokens ?? 0);
  const completionTokens = (job.completionTokens ?? 0) + (response.completionTokens ?? 0);
  const batchCost = (deps.estimateCostUsd ?? estimateCostUsd)(job.model, response.promptTokens, response.completionTokens);
  const nowFinished = nowMs();

  await db()
    .update(aiGenerationBatches)
    .set({
      status: "succeeded",
      produced: rows.length,
      accepted: acceptedThisBatch,
      flagged,
      rawItemCount: funnel.rawItemCount,
      modelShortfallCount: funnel.modelShortfallCount,
      schemaValidCount: funnel.schemaValidCount,
      schemaInvalidCount: funnel.schemaInvalidCount,
      contentValidCount: funnel.contentValidCount,
      contentInvalidCount: funnel.contentInvalidCount,
      policyValidCount: funnel.policyValidCount,
      policyRejectedCount: funnel.policyRejectedCount,
      duplicateFlaggedCount: funnel.duplicateFlaggedCount,
      finishReason: response.finishReason ?? null,
      parseRepair: parsed.repair,
      responseFormatMode,
      promptTokens: response.promptTokens,
      completionTokens: response.completionTokens,
      costUsd: batchCost,
      durationMs: nowFinished - startedAt,
      rawResponseKey: key,
      finishedAt: nowFinished,
    })
    .where(eq(aiGenerationBatches.id, batchId));

  // ── the growing job-local memory ──────────────────────────────────────────
  const concepts = [...(parseJsonArray(job.coveredConcepts) ?? []), ...acceptedConcepts];
  const coveredConcepts = capConcepts(concepts);

  // ── terminal decision ─────────────────────────────────────────────────────
  const stall = await stallReason(job.id);
  let status: string;
  let errorCode: string | null = null;
  let errorMessage: string | null = null;

  if (acceptedTotal >= job.requestedCount) {
    status = "succeeded";
  } else if (stall === "covered") {
    status = "partial";
    errorCode = "SATURATED";
    errorMessage = `The bank already covers this topic: ${acceptedTotal} of ${job.requestedCount} accepted, and the last two batches produced almost nothing new.`;
  } else if (stall === "no_output") {
    status = acceptedTotal > 0 ? "partial" : "failed";
    errorCode = "NO_CANDIDATES";
    errorMessage = "The model returned no usable questions for this topic.";
  } else if (stall === "delivery") {
    status = acceptedTotal > 0 ? "partial" : "failed";
    errorCode = "DELIVERY_STALL";
    errorMessage = "The model repeatedly returned far fewer items than requested.";
  } else if (stall === "format") {
    status = acceptedTotal > 0 ? "partial" : "failed";
    errorCode = "FORMAT_STALL";
    errorMessage = "The model repeatedly returned items that did not match the required schema.";
  } else if (stall === "policy") {
    status = acceptedTotal > 0 ? "partial" : "failed";
    errorCode = "POLICY_FAILURE";
    errorMessage = "The model repeatedly ignored the approved coverage policy.";
  } else if (callNo >= job.maxCalls) {
    status = acceptedTotal > 0 ? "partial" : "failed";
    errorCode = "MAX_CALLS";
    errorMessage = `Reached the ${job.maxCalls}-call limit with ${acceptedTotal} of ${job.requestedCount} accepted.`;
  } else {
    status = "running";
  }

  await assertGenerationLease(job.id, leaseToken);

  await db()
    .update(aiGenerationJobs)
    .set({
      status,
      phase: status === "running" ? "generating" : "reviewable",
      producedCount: produced,
      validCount: job.validCount + funnel.contentValidCount,
      duplicateCount: duplicateTotal,
      duplicateSkipped: duplicateTotal,
      acceptedCount: acceptedTotal,
      rawItemCount: job.rawItemCount + funnel.rawItemCount,
      modelShortfallCount: job.modelShortfallCount + funnel.modelShortfallCount,
      schemaInvalidCount: job.schemaInvalidCount + funnel.schemaInvalidCount,
      contentInvalidCount: job.contentInvalidCount + funnel.contentInvalidCount,
      policyRejectedCount: job.policyRejectedCount + funnel.policyRejectedCount,
      backfillRound: callNo,
      coveredConcepts: coveredConcepts.length > 0 ? JSON.stringify(coveredConcepts) : null,
      rawResponseKey: key,
      promptTokens,
      completionTokens,
      // Generation tokens for the whole job so far, plus the one-off search cost.
      costUsd:
        Math.round(
          (((deps.estimateCostUsd ?? estimateCostUsd)(job.model, promptTokens, completionTokens) ?? 0) + groundingCost + (job.plannerCostUsd ?? 0)) *
            1_000_000,
        ) / 1_000_000,
      finishedAt: status === "running" ? null : nowFinished,
      durationMs: job.startedAt ? nowFinished - job.startedAt : nowFinished - startedAt,
      errorCode,
      errorMessage,
    })
    .where(eq(aiGenerationJobs.id, job.id));

  logInfo("ai", `batch ${batchNo} done for ${job.id}`, {
    status,
    asked: effectiveAsk,
    stored: rows.length,
    acceptedThisBatch,
    flaggedThisBatch: flagged,
    acceptedTotal,
    producedTotal: produced,
    requested: job.requestedCount,
    schemaInvalid: funnel.schemaInvalidCount,
    contentInvalid: funnel.contentInvalidCount,
    policyRejected: funnel.policyRejectedCount,
    modelShortfall: funnel.modelShortfallCount,
    saturationRate: SATURATION_RATE,
    maxTokens,
    completionTokens: response.completionTokens,
    outputBytes: response.text.length,
  });

  await recordAudit(job.createdBy, "ai.job_batch", "ai_job", job.id, null, {
    batchNo,
    asked: effectiveAsk,
    stored: rows.length,
    accepted: acceptedThisBatch,
    flagged,
    acceptedTotal,
    status,
  });

  return progressOf(await getJob(job.id));
}

/** One retry when the provider itself says the failure is transient. */
async function callWithRetry(
  deps: GenerationDeps,
  request: Parameters<LlmProvider["generate"]>[0],
  onFallback: (fallbackRequest: Parameters<LlmProvider["generate"]>[0]) => Promise<void>,
): Promise<{ response: Awaited<ReturnType<LlmProvider["generate"]>>; mode: "json_schema" | "json_object_fallback" }> {
  const attempt = async (candidate: typeof request) => {
    try {
      return await deps.provider.generate(candidate);
    } catch (error) {
      if (error instanceof LlmError && error.retryable) {
        logWarn("ai", "provider call failed — retrying once", { code: error.code, message: error.message });
        return deps.provider.generate(candidate);
      }
      throw error;
    }
  };
  try {
    return { response: await attempt(request), mode: "json_schema" };
  } catch (error) {
    if (!(error instanceof LlmError) || !request.responseSchema || ![400, 422].includes(error.status ?? 0)) throw error;
    logWarn("ai", "strict structured output unsupported; trying JSON-object fallback", { model: request.model, status: error.status });
    const fallbackRequest = { ...request, responseSchema: undefined };
    await onFallback(fallbackRequest);
    return { response: await attempt(fallbackRequest), mode: "json_object_fallback" };
  }
}

/**
 * The job's prompt context: what the BANK covers (built once at creation) plus
 * what THIS JOB has already generated, so later batches cannot repeat them.
 */
function buildJobDigest(
  job: AiGenerationJob,
  sourcePoolJson: string | null = job.sourcePool,
  includeSourcePool = true,
): string {
  const parts: string[] = [];

  // 1. The shared grounding pool (built once, reused by every batch as text).
  const pool = parseSourcePool(sourcePoolJson);
  if (pool && includeSourcePool) parts.push(renderSourcePool(pool));

  // 2. What the BANK already covers for this topic.
  if (job.coverageDigest) parts.push(job.coverageDigest);

  // 3. What THIS JOB has already generated.
  const concepts = parseJsonArray(job.coveredConcepts) ?? [];
  if (concepts.length > 0) {
    const lines: string[] = [];
    let used = 0;
    for (const concept of concepts) {
      const line = `- ${concept}`;
      const cost = estimateTokens(`${line}\n`);
      if (used + cost > JOB_CONCEPTS_MAX_TOKENS) {
        lines.push(`- …and ${concepts.length - lines.length} more already-generated concepts`);
        break;
      }
      lines.push(line);
      used += cost;
    }
    parts.push(
      "",
      `ALREADY GENERATED IN THIS JOB (do NOT repeat these; ${concepts.length} so far):`,
      ...lines,
    );
  }

  return parts.join("\n");
}

/** Tolerant reader for a stored source pool. */
function parseSourcePool(raw: string | null): SourcePool | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as SourcePool;
    if (!parsed || !Array.isArray(parsed.extracts)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Comma-separated domain lists from settings. */
function splitDomains(raw: string): string[] {
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

/** Trim the job-local concept list to its token budget, keeping the newest. */
function capConcepts(concepts: string[]): string[] {
  const kept: string[] = [];
  let used = 0;
  for (let i = concepts.length - 1; i >= 0; i--) {
    const cost = estimateTokens(`- ${concepts[i]}\n`);
    if (used + cost > JOB_CONCEPTS_MAX_TOKENS) break;
    kept.unshift(concepts[i]!);
    used += cost;
  }
  return kept;
}

/**
 * Two consecutive batches that both yielded almost nothing new mean the job has
 * stalled — either the bank already covers the topic or the model has stopped
 * returning usable questions. Either way: stop rather than burn calls.
 */
async function stallReason(jobId: string): Promise<"covered" | "no_output" | "delivery" | "format" | "policy" | null> {
  const rows = await db()
    .select({
      asked: aiGenerationBatches.asked,
      raw: aiGenerationBatches.rawItemCount,
      schemaValid: aiGenerationBatches.schemaValidCount,
      contentValid: aiGenerationBatches.contentValidCount,
      policyValid: aiGenerationBatches.policyValidCount,
      policyRejected: aiGenerationBatches.policyRejectedCount,
      duplicateFlagged: aiGenerationBatches.duplicateFlaggedCount,
      accepted: aiGenerationBatches.accepted,
    })
    .from(aiGenerationBatches)
    .where(and(
      eq(aiGenerationBatches.jobId, jobId),
      inArray(aiGenerationBatches.status, ["succeeded", "failed"]),
    ))
    .orderBy(desc(aiGenerationBatches.batchNo))
    .limit(2);

  if (rows.length < 2) return null;

  if (rows.every((row) => row.raw === 0)) return "no_output";
  if (rows.every((row) => row.accepted === 0 && row.raw / Math.max(1, row.asked) < SATURATION_RATE)) return "delivery";
  if (rows.every((row) => row.schemaValid / Math.max(1, row.raw) < SATURATION_RATE)) return "format";
  if (rows.every((row) => row.policyRejected / Math.max(1, row.contentValid) >= 0.75)) return "policy";
  if (rows.every((row) => row.accepted / Math.max(1, row.policyValid) < SATURATION_RATE && row.duplicateFlagged > 0)) {
    return "covered";
  }
  return null;
}

async function finishJob(
  jobId: string,
  status: string,
  errorCode: string | null = null,
  errorMessage: string | null = null,
): Promise<void> {
  await db()
    .update(aiGenerationJobs)
    .set({ status, phase: "reviewable", errorCode, errorMessage, finishedAt: nowMs() })
    .where(eq(aiGenerationJobs.id, jobId));
}

async function bumpCallCount(jobId: string, batchNo: number): Promise<void> {
  await db()
    .update(aiGenerationJobs)
    .set({ backfillRound: batchNo })
    .where(eq(aiGenerationJobs.id, jobId));
}

async function failBatch(
  batchId: string,
  startedAt: number,
  errorCode: string,
  errorMessage: string,
): Promise<void> {
  await db()
    .update(aiGenerationBatches)
    .set({
      status: "failed",
      errorCode,
      errorMessage,
      durationMs: nowMs() - startedAt,
      finishedAt: nowMs(),
    })
    .where(eq(aiGenerationBatches.id, batchId));
}

async function nextBatchNumber(jobId: string): Promise<number> {
  const latest = await db()
    .select({ batchNo: aiGenerationBatches.batchNo })
    .from(aiGenerationBatches)
    .where(eq(aiGenerationBatches.jobId, jobId))
    .orderBy(desc(aiGenerationBatches.batchNo))
    .limit(1);
  return (latest[0]?.batchNo ?? 0) + 1;
}

/** Fences a slow response after cancellation or an expired lease was reclaimed. */
async function assertGenerationLease(jobId: string, leaseToken: string): Promise<void> {
  const row = await getJob(jobId);
  if (row.leaseToken !== leaseToken || row.status === "cancelled" || row.committedAt != null) {
    throw conflict("The generation lease was lost; this late response will not be applied.");
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return JSON.stringify({ unavailable: "Value was not JSON-serializable." });
  }
}

function normalizePolicyKey(value: string | null): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function candidateRow(input: {
  candidate: ParsedCandidate;
  job: AiGenerationJob;
  batchNo: number;
  batchIndex: number;
  createdAt: number;
  rejected: boolean;
  dedupeStatus?: string;
  matchedQuestionId?: string | null;
  matchedStem?: string | null;
  similarity?: number | null;
  dedupeReason?: string | null;
  rejectionKind?: string | null;
  rejectionReason?: string | null;
}): typeof aiCandidates.$inferInsert {
  const { candidate } = input;
  return {
    id: newId(),
    jobId: input.job.id,
    batchIndex: input.batchIndex,
    batchNo: input.batchNo,
    superseded: 0,
    stem: candidate.draft.stem,
    optionsJson: JSON.stringify(candidate.draft.options),
    correctOptionKey: candidate.draft.correctOptionKey,
    explanation: candidate.draft.explanation ?? null,
    backstory: candidate.draft.backstory ?? null,
    difficulty: candidate.draft.difficulty ?? "medium",
    topic: candidate.draft.topic ?? input.job.topic,
    tags: candidate.draft.tags?.length ? JSON.stringify(candidate.draft.tags) : null,
    segmentId: candidate.metadata.segmentId,
    entityKey: candidate.metadata.entityKey,
    factKey: candidate.metadata.factKey,
    questionType: candidate.metadata.questionType,
    sourceIdsJson: candidate.metadata.sourceIds.length > 0 ? JSON.stringify(candidate.metadata.sourceIds) : null,
    rejectionKind: input.rejectionKind ?? null,
    rejectionReason: input.rejectionReason ?? null,
    planRevision: input.job.planRevision,
    rejected: input.rejected ? 1 : 0,
    dedupeStatus: input.dedupeStatus ?? "clean",
    dedupeMatchedQuestionId: input.matchedQuestionId ?? null,
    dedupeMatchedStem: input.matchedStem ?? null,
    dedupeSimilarity: input.similarity ?? null,
    dedupeReason: input.dedupeReason ?? null,
    createdAt: input.createdAt,
  };
}

/** Persist the planner-scoped fact pack once and update its segment coverage. */
async function persistSourceFacts(
  jobId: string,
  segments: Awaited<ReturnType<typeof listGenerationSegments>>,
  pool: SourcePool,
): Promise<void> {
  const already = await db().select({ id: aiSourceFacts.id }).from(aiSourceFacts).where(eq(aiSourceFacts.jobId, jobId)).limit(1);
  if (already.length > 0 || segments.length === 0) return;

  const byKey = new Map(segments.map((segment) => [segment.key, segment]));
  const counts = new Map<string, number>();
  const citedUrls = new Set(pool.citations);
  for (const extract of pool.extracts) {
    // Never invent a citation or assign an unscoped claim round-robin to a
    // coverage segment. Unsupported segments must stay visibly source-limited.
    const segment = extract.segmentId ? byKey.get(extract.segmentId) : null;
    const sourceUrl = extract.url;
    if (!sourceUrl || !citedUrls.has(sourceUrl)) continue;
    await db().insert(aiSourceFacts).values({
      id: newId(),
      jobId,
      segmentId: segment?.id ?? null,
      entityKey: extract.entityKey ?? null,
      claim: extract.excerpt,
      sourceUrl,
      sourceTitle: extract.title || sourceUrl,
      publishedAt: extract.publishedAt ?? null,
      freshness: extract.freshness ?? "stable",
      retrievedAt: pool.fetchedAt,
    });
    if (segment) counts.set(segment.id, (counts.get(segment.id) ?? 0) + 1);
  }
  for (const segment of segments) {
    const count = counts.get(segment.id) ?? 0;
    await db().update(aiGenerationSegments).set({
      sourceFactCount: count,
      status: count > 0 ? "active" : "source_limited",
      updatedAt: nowMs(),
    }).where(eq(aiGenerationSegments.id, segment.id));
  }
}

async function updateSegmentLedgers(
  segments: Awaited<ReturnType<typeof listGenerationSegments>>,
  rows: Array<typeof aiCandidates.$inferInsert>,
  unassignedInvalid: number,
): Promise<void> {
  for (const segment of segments) {
    const relevant = rows.filter((row) => row.segmentId === segment.key);
    const accepted = relevant.filter((row) => row.rejected === 0).length;
    const rejected = relevant.length - accepted;
    const invalid = segment === segments[0] ? unassignedInvalid : 0;
    const acceptedTotal = segment.acceptedCount + accepted;
    await db().update(aiGenerationSegments).set({
      acceptedCount: acceptedTotal,
      rejectedCount: segment.rejectedCount + rejected,
      invalidCount: segment.invalidCount + invalid,
      status: acceptedTotal >= segment.targetCount
        ? "complete"
        : segment.sourceFactCount === 0 ? "source_limited" : "active",
      updatedAt: nowMs(),
    }).where(eq(aiGenerationSegments.id, segment.id));
  }
}

async function recentFailureHints(jobId: string): Promise<string[]> {
  const rows = await db().select({
    asked: aiGenerationBatches.asked,
    raw: aiGenerationBatches.rawItemCount,
    schemaInvalid: aiGenerationBatches.schemaInvalidCount,
    contentInvalid: aiGenerationBatches.contentInvalidCount,
    policyRejected: aiGenerationBatches.policyRejectedCount,
    errorCode: aiGenerationBatches.errorCode,
  }).from(aiGenerationBatches)
    .where(eq(aiGenerationBatches.jobId, jobId))
    .orderBy(desc(aiGenerationBatches.batchNo))
    .limit(2);
  return rows.flatMap((row) => {
    const hints: string[] = [];
    if (row.errorCode) hints.push(`Previous call failed with ${row.errorCode}. Return complete JSON matching the schema.`);
    if (row.raw < row.asked) hints.push(`Previous call returned ${row.raw}/${row.asked} requested items; complete the exact count.`);
    if (row.schemaInvalid > 0) hints.push(`${row.schemaInvalid} previous items failed the JSON schema.`);
    if (row.contentInvalid > 0) hints.push(`${row.contentInvalid} previous items failed content validation, commonly backstory or option quality.`);
    if (row.policyRejected > 0) hints.push(`${row.policyRejected} previous items violated segment/entity/fact policy.`);
    return hints;
  }).slice(0, 6);
}

/**
 * Normalized hashes of a job's already-stored candidates, with enough context to
 * name the question a later duplicate matched ("Already produced as Q4").
 */
async function loadBatchHashes(
  jobId: string,
): Promise<Map<string, { stem: string; batchIndex: number | null }>> {
  const rows = await db()
    .select({
      stem: aiCandidates.stem,
      optionsJson: aiCandidates.optionsJson,
      batchIndex: aiCandidates.batchIndex,
    })
    .from(aiCandidates)
    .where(eq(aiCandidates.jobId, jobId));

  const hashes = new Map<string, { stem: string; batchIndex: number | null }>();
  for (const row of rows) {
    let bodies: string[] = [];
    try {
      const options = JSON.parse(row.optionsJson) as Array<{ body?: unknown }>;
      bodies = options.map((option) => String(option.body ?? ""));
    } catch {
      bodies = [];
    }
    const hash = await computeDedupeHashes(row.stem, bodies);
    hashes.set(hash.normalizedHash, { stem: row.stem, batchIndex: row.batchIndex });
  }
  return hashes;
}

// ── the working set: read and reject ─────────────────────────────────────────

export type CandidateWithJob = AiCandidate & { model: string; jobTopic: string };

export async function listCandidates(
  options: { jobId?: string; rejected?: boolean; limit?: number } = {},
): Promise<CandidateWithJob[]> {
  const filters = [];
  if (options.jobId) filters.push(eq(aiCandidates.jobId, options.jobId));
  if (options.rejected !== undefined) filters.push(eq(aiCandidates.rejected, options.rejected ? 1 : 0));

  const rows = await db()
    .select({
      candidate: aiCandidates,
      model: aiGenerationJobs.model,
      jobTopic: aiGenerationJobs.topic,
    })
    .from(aiCandidates)
    .innerJoin(aiGenerationJobs, eq(aiGenerationJobs.id, aiCandidates.jobId))
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(aiCandidates.createdAt))
    .limit(Math.min(200, Math.max(1, options.limit ?? 50)));

  return rows.map((row) => ({ ...row.candidate, model: row.model, jobTopic: row.jobTopic }));
}

/** All live candidates of a job in batch order — the review screen's payload. */
export async function listJobCandidates(jobId: string): Promise<CandidateWithJob[]> {
  const rows = await db()
    .select({
      candidate: aiCandidates,
      model: aiGenerationJobs.model,
      jobTopic: aiGenerationJobs.topic,
    })
    .from(aiCandidates)
    .innerJoin(aiGenerationJobs, eq(aiGenerationJobs.id, aiCandidates.jobId))
    .where(and(eq(aiCandidates.jobId, jobId), eq(aiCandidates.superseded, 0)))
    .limit(400);

  return rows
    .map((row) => ({ ...row.candidate, model: row.model, jobTopic: row.jobTopic }))
    .sort((a, b) => (a.batchIndex ?? 0) - (b.batchIndex ?? 0));
}

/**
 * Rebuild the job-local concept list from the questions that are still live.
 * Used after a per-batch regenerate supersedes rows, so the replacement batch
 * does not treat the discarded questions as already covered.
 */
function conceptsFromCandidates(candidates: AiCandidate[]): string[] {
  const concepts: string[] = [];
  for (const candidate of candidates) {
    if (candidate.rejected !== 0) continue;
    let answer: string | null = null;
    try {
      const options = JSON.parse(candidate.optionsJson) as Array<{ key?: string; body?: string }>;
      answer = options.find((option) => option.key === candidate.correctOptionKey)?.body ?? null;
    } catch {
      answer = null;
    }
    const concept = extractConceptKey(candidate.stem, answer);
    if (concept) concepts.push(concept);
  }
  return capConcepts(concepts);
}

/** Every internal call of a job, oldest first — the progress panel's payload. */
export async function listJobBatches(jobId: string): Promise<AiGenerationBatch[]> {
  return db()
    .select()
    .from(aiGenerationBatches)
    .where(eq(aiGenerationBatches.jobId, jobId))
    .orderBy(aiGenerationBatches.batchNo);
}

export async function listJobRejections(jobId: string) {
  return db()
    .select()
    .from(aiGenerationRejections)
    .where(eq(aiGenerationRejections.jobId, jobId))
    .orderBy(aiGenerationRejections.batchNo, aiGenerationRejections.modelIndex);
}

export async function listJobSourceFacts(jobId: string) {
  return db()
    .select()
    .from(aiSourceFacts)
    .where(eq(aiSourceFacts.jobId, jobId));
}

export async function getCandidate(id: string): Promise<AiCandidate> {
  const row = (await db().select().from(aiCandidates).where(eq(aiCandidates.id, id)).limit(1))[0];
  if (!row) throw notFound("Candidate not found.");
  return row;
}

/** The reviewer's one decision. Rejected rows are simply skipped at commit. */
export async function setCandidateRejected(
  id: string,
  rejected: boolean,
  actorId: string,
): Promise<AiCandidate> {
  const candidate = await getCandidate(id);
  await db()
    .update(aiCandidates)
    .set({ rejected: rejected ? 1 : 0 })
    .where(eq(aiCandidates.id, id));

  const live = await db().select().from(aiCandidates).where(and(
    eq(aiCandidates.jobId, candidate.jobId),
    eq(aiCandidates.superseded, 0),
  ));
  const accepted = live.filter((row) => row.rejected === 0);
  const job = await getJob(candidate.jobId);
  const reachesTarget = accepted.length >= job.requestedCount;
  await db().update(aiGenerationJobs).set({
    acceptedCount: accepted.length,
    ...(reachesTarget && ["queued", "running"].includes(job.status)
      ? { status: "succeeded", phase: "reviewable", finishedAt: nowMs(), errorCode: null, errorMessage: null }
      : {}),
  }).where(eq(aiGenerationJobs.id, candidate.jobId));

  if (job.planRevision > 0) {
    const segments = await listGenerationSegments(job.id, job.planRevision);
    for (const segment of segments) {
      const segmentRows = live.filter((row) => row.segmentId === segment.key);
      const acceptedCount = segmentRows.filter((row) => row.rejected === 0).length;
      await db().update(aiGenerationSegments).set({
        acceptedCount,
        rejectedCount: segmentRows.length - acceptedCount,
        status: acceptedCount >= segment.targetCount ? "complete" : segment.sourceFactCount > 0 ? "active" : "source_limited",
        updatedAt: nowMs(),
      }).where(eq(aiGenerationSegments.id, segment.id));
    }
  }
  await recordAudit(actorId, rejected ? "ai.candidate_reject" : "ai.candidate_keep", "ai_candidate", id);
  return { ...candidate, rejected: rejected ? 1 : 0 };
}

// ── commit: the kept set becomes real, playable questions ────────────────────

export type CommitOutcome = {
  jobId: string;
  /** Questions created and attached, in batch order. */
  promoted: Array<{ candidateId: string; questionId: string }>;
  /** Candidates that could not be added, with the reason. */
  failed: Array<{ candidateId: string; reason: string }>;
  /** Applied only when promoting to a NEW set. */
  createdSet: { id: string; title: string } | null;
  newSetId: string | null;
  questionIds: string[];
};

/**
 * The single commit action: insert every NON-rejected candidate of a job into
 * the question bank as an ACTIVE question, then attach the whole set to one
 * Q Set — an existing one or a brand-new one.
 *
 * `active` + attached to a published set = instantly playable. There is no
 * separate per-question publish step (REVAMP-PLAN.md §0/G2).
 */
export async function commitJobToSet(
  jobId: string,
  actorId: string,
  target: {
    setId?: string | null;
    newSet?: {
      title: string;
      categoryId: string;
      mode?: string;
      difficulty?: string;
      description?: string | null;
    } | null;
    /**
     * Explicit reviewer selection. When present it wins outright: only these
     * candidates are added, in batch order, and the target-count trim is skipped
     * (the human already chose). Unknown/rejected ids are ignored.
     */
    candidateIds?: string[] | null;
  },
): Promise<CommitOutcome> {
  const job = await getJob(jobId);
  if (job.committedAt != null) {
    throw conflict("This batch has already been added to a Q Set.");
  }
  if (!["succeeded", "partial", "cancelled"].includes(job.status)) {
    throw conflict("Questions can be committed only after generation has stopped.");
  }
  if (job.leaseToken && (job.leaseExpiresAt ?? 0) > nowMs()) {
    throw conflict("Generation is still active. Wait for the current batch to finish.");
  }

  const hasExisting = Boolean(target.setId?.trim());
  const hasNew = Boolean(target.newSet?.title?.trim());
  if (hasExisting === hasNew) {
    throw validationError("Choose exactly one: an existing Q Set, or a new one.");
  }

  let setId: string;
  let createdSet: CommitOutcome["createdSet"] = null;

  if (hasNew) {
    const { createSet } = await import("@/modules/catalog");
    const set = await createSet(
      {
        categoryId: target.newSet!.categoryId,
        title: target.newSet!.title.trim(),
        description: target.newSet?.description ?? null,
        mode: (target.newSet?.mode as never) ?? "practice",
        difficulty: target.newSet?.difficulty ?? "medium",
      },
      actorId,
    );
    createdSet = { id: set.id, title: set.title };
    setId = set.id;
  } else {
    setId = target.setId!;
  }

  const kept = (await listJobCandidates(jobId)).filter((candidate) => candidate.rejected === 0);

  if (job.planApprovedAt != null && kept.some((candidate) => candidate.planRevision !== job.planRevision)) {
    throw conflict("The selected candidates do not all belong to the approved plan revision.");
  }

  let candidates: typeof kept;
  let trimmed = 0;
  if (target.candidateIds && target.candidateIds.length > 0) {
    // The reviewer ticked specific questions: honour that exactly.
    const chosen = new Set(target.candidateIds);
    candidates = kept.filter((candidate) => chosen.has(candidate.id));
    if (candidates.length === 0) {
      throw validationError("None of the selected questions can be added.");
    }
  } else {
    /**
     * D1 — auto-trim. Generation is allowed to overshoot the target (a batch is
     * never a degenerate 1-question prompt), but the Q Set receives exactly the
     * number that was asked for. The overflow stays in the review screen and can
     * be swapped in later.
     */
    candidates = kept.slice(0, Math.max(1, job.requestedCount));
    trimmed = kept.length - candidates.length;
  }

  const promoted: CommitOutcome["promoted"] = [];
  const failed: CommitOutcome["failed"] = [];
  let duplicateOverrides = 0;

  for (const candidate of candidates) {
    try {
      const parsedOptions = JSON.parse(candidate.optionsJson) as Array<{
        key: "A" | "B" | "C" | "D" | "E";
        body: string;
      }>;

      const draft: QuestionDraft = {
        stem: candidate.stem,
        options: parsedOptions,
        correctOptionKey: candidate.correctOptionKey as "A" | "B" | "C" | "D" | "E",
        explanation: candidate.explanation,
        backstory: candidate.backstory,
        difficulty: candidate.difficulty ?? "medium",
        topic: candidate.topic,
        tags: candidate.tags ? (JSON.parse(candidate.tags) as string[]) : [],
        year: null,
        examBody: null,
        source: null,
        sourceUrl: null,
      };

      /**
       * The same funnel as manual authoring — EXCEPT that a candidate the dedupe
       * flagged and the admin explicitly accepted is inserted anyway. That is the
       * whole point of showing duplicates instead of hiding them: the human's
       * decision wins. It is counted and audited so the override is never silent.
       */
      const override = candidate.dedupeStatus !== "clean";
      if (override) duplicateOverrides++;

      const { question } = await createQuestion(draft, actorId, {
        status: "active" as QuestionStatus,
        origin: "ai",
        generationJobId: job.id,
        allowDuplicate: override,
      });
      promoted.push({ candidateId: candidate.id, questionId: question.id });
    } catch (error) {
      failed.push({
        candidateId: candidate.id,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const questionIds = promoted.map((entry) => entry.questionId);
  let attached = 0;
  let attachSkipped = 0;
  if (questionIds.length > 0) {
    const { attachQuestions } = await import("@/modules/questions");
    const result = await attachQuestions(setId, questionIds, actorId);
    attached = result.added;
    attachSkipped = result.skipped;
  }

  await db()
    .update(aiGenerationJobs)
    .set({ committedSetId: setId, committedAt: nowMs() })
    .where(eq(aiGenerationJobs.id, jobId));

  await recordAudit(actorId, "ai.job_committed", "ai_job", jobId, null, {
    setId,
    createdSet: createdSet?.id ?? null,
    promoted: promoted.length,
    trimmedFromOvershoot: trimmed,
    duplicateOverrides,
    attached,
    attachSkipped,
    failed: failed.length,
  });

  logInfo("ai", `job ${jobId} committed`, {
    setId,
    createdSet: createdSet?.id ?? null,
    promoted: promoted.length,
    trimmedFromOvershoot: trimmed,
    duplicateOverrides,
    attached,
    failed: failed.length,
  });

  return { jobId, promoted, failed, createdSet, newSetId: createdSet?.id ?? null, questionIds };
}

/**
 * Regenerate ONE internal batch (PIPELINE-PLAN.md §9 / P1).
 *
 * Supersede — never delete: the batch's rows are flagged `superseded` and kept
 * for audit, so a failed regenerate can never destroy the only copy. The job's
 * counters and concept list are rebuilt from what is still live, which returns
 * the accepted count to below the target so the next `/step` produces a fresh
 * batch of the same shape.
 */
export async function regenerateBatch(
  jobId: string,
  batchNo: number,
  actorId: string,
): Promise<{ superseded: number; job: AiGenerationJob }> {
  const job = await getJob(jobId);
  if (job.committedAt != null) {
    throw conflict("This batch has already been added to a Q Set.");
  }

  const batch = (
    await db()
      .select()
      .from(aiGenerationBatches)
      .where(and(eq(aiGenerationBatches.jobId, jobId), eq(aiGenerationBatches.batchNo, batchNo)))
      .limit(1)
  )[0];
  if (!batch) throw notFound(`Batch ${batchNo} not found.`);
  if (batch.status === "superseded") {
    throw conflict(`Batch ${batchNo} has already been regenerated.`);
  }
  if (batch.status === "running") {
    throw conflict(`Batch ${batchNo} is still running.`);
  }

  // 1. Supersede the batch's live rows (audited, never deleted).
  const live = await db()
    .select()
    .from(aiCandidates)
    .where(
      and(
        eq(aiCandidates.jobId, jobId),
        eq(aiCandidates.batchNo, batchNo),
        eq(aiCandidates.superseded, 0),
      ),
    );

  for (const row of live) {
    await db()
      .update(aiCandidates)
      .set({ superseded: 1 })
      .where(eq(aiCandidates.id, row.id));
  }

  await db()
    .update(aiGenerationBatches)
    .set({ status: "superseded", finishedAt: nowMs() })
    .where(eq(aiGenerationBatches.id, batch.id));

  // 2. Recompute the job from what is still live.
  const remaining = await db()
    .select()
    .from(aiCandidates)
    .where(and(eq(aiCandidates.jobId, jobId), eq(aiCandidates.superseded, 0)));

  const accepted = remaining.filter((row) => row.rejected === 0);
  const flagged = remaining.length - accepted.length;
  const concepts = conceptsFromCandidates(remaining);

  await db()
    .update(aiGenerationJobs)
    .set({
      producedCount: remaining.length,
      validCount: remaining.length,
      duplicateCount: flagged,
      duplicateSkipped: flagged,
      acceptedCount: accepted.length,
      coveredConcepts: concepts.length > 0 ? JSON.stringify(concepts) : null,
      // A deliberate regenerate earns its own call beyond the original cap.
      maxCalls: job.maxCalls + 1,
      status: "running",
      phase: "generating",
      finishedAt: null,
      errorCode: null,
      errorMessage: null,
    })
    .where(eq(aiGenerationJobs.id, jobId));

  if (job.planRevision > 0) {
    const segments = await listGenerationSegments(job.id, job.planRevision);
    for (const segment of segments) {
      const segmentRows = remaining.filter((row) => row.segmentId === segment.key);
      const segmentAccepted = segmentRows.filter((row) => row.rejected === 0).length;
      await db().update(aiGenerationSegments).set({
        acceptedCount: segmentAccepted,
        rejectedCount: segmentRows.length - segmentAccepted,
        status: segmentAccepted >= segment.targetCount ? "complete" : segment.sourceFactCount > 0 ? "active" : "source_limited",
        updatedAt: nowMs(),
      }).where(eq(aiGenerationSegments.id, segment.id));
    }
  }

  await recordAudit(actorId, "ai.batch_regenerated", "ai_job", jobId, null, {
    batchNo,
    superseded: live.length,
    acceptedAfter: accepted.length,
  });

  logInfo("ai", `batch ${batchNo} regenerated for ${jobId}`, {
    superseded: live.length,
    acceptedAfter: accepted.length,
    requested: job.requestedCount,
  });

  return { superseded: live.length, job: await getJob(jobId) };
}
