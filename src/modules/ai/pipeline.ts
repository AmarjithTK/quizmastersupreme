/**
 * AI generation pipeline (M10). PLAN.md §12.
 *
 * TRANSPORT: this module is deliberately queue-agnostic. `runGenerationStep()`
 * is a plain async function; something else decides when to call it.
 *
 * Why not a Cloudflare Queue consumer? vinext owns the Worker entry point
 * (its `fetch-handler` re-exports a virtual entry), so there is nowhere to
 * attach a `queue()` handler without replacing the entry. The job is therefore
 * advanced in TWO BOUNDED STEPS driven by the admin UI:
 *
 *   step 1  queued  → running   one LLM call, raw response archived
 *   step 2  running → terminal   parse, validate, dedupe, store candidates
 *
 * That satisfies §2.8's actual requirements — no request runs the whole job,
 * work survives a closed browser because every step is persisted in D1, and a
 * failed job is retryable — and `runGenerationStep` is exactly what a queue
 * consumer would call once the entry can be customised.
 *
 * HARD RULE (§2.2): nothing here writes to `questions`. Promotion goes through
 * `createQuestion()` after a human approves the candidate.
 */

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db/client";
import {
  aiCandidates,
  aiGenerationJobs,
  newId,
  nowMs,
  type AiCandidate,
  type AiGenerationJob,
  type QuestionStatus,
} from "@/db/schema";
import { conflict, notFound, validationError } from "@/lib/errors";
import { recordAudit } from "@/modules/audit";
import { logError, logInfo, logWarn, logException } from "@/lib/logger";
import { checkCandidates, type SemanticDedupe } from "@/modules/dedupe";
import { simhashHex } from "@/modules/dedupe/simhash";
import { createQuestion, validateQuestion, type QuestionDraft } from "@/modules/questions";
import {
  GenerationParseError,
  parseGenerationResponse,
  type ParsedCandidate,
  type RejectedCandidate,
} from "./parse";
import { buildSystemPrompt, buildUserPrompt, PROMPT_VERSION } from "./prompts/generate";
import { estimateCostUsd, LlmError, type LlmProvider } from "./provider";
import { buildCoverageDigest } from "./coverage";

const MAX_BOUND_PARAMS = 90;
const MAX_REQUESTED = 50;

export type RawStorage = {
  put(key: string, value: string): Promise<void>;
  get(key: string): Promise<string | null>;
};

export type GenerationDeps = {
  provider: LlmProvider;
  storage: RawStorage;
  /** Layer 3 deps; absent means candidates are checked by layers 1-2 only. */
  semantic?: SemanticDedupe | null;
};

export type JobProgress = {
  jobId: string;
  status: string;
  producedCount: number;
  validCount: number;
  duplicateCount: number;
  /** True once the job can advance no further without an admin action. */
  done: boolean;
  error: string | null;
};

export type CreateJobInput = {
  topic: string;
  brief: string;
  requestedCount: number;
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

// ── job lifecycle ────────────────────────────────────────────────────────────

export async function createGenerationJob(
  input: CreateJobInput,
  actorId: string,
): Promise<AiGenerationJob> {
  const topic = input.topic.trim();
  if (!topic) throw validationError("A topic is required.");
  if (!input.brief.trim()) throw validationError("A brief is required.");
  if (!Number.isInteger(input.requestedCount) || input.requestedCount < 1) {
    throw validationError("Request at least one question.");
  }
  if (input.requestedCount > MAX_REQUESTED) {
    throw validationError(`Request at most ${MAX_REQUESTED} questions per job.`);
  }
  if (!input.model.trim()) throw validationError("A model is required.");

  // Compress what the bank already covers for this topic. An LLM call is
  // stateless, so without this it re-asks the same facts every time (§12.4).
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
    provider: "openrouter",
    model: input.model.trim(),
    temperature: input.temperature ?? null,
    promptVersion: PROMPT_VERSION,
    coverageDigest: digest.text || null,
    coverageTokens: digest.estimatedTokens,
    includeExamples: input.includeExamples ? 1 : 0,
    status: "queued",
    producedCount: 0,
    validCount: 0,
    duplicateCount: 0,
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
    actorId,
    coverageQuestions: digest.questionCount,
    coverageConcepts: digest.conceptCount,
    coverageTokens: digest.estimatedTokens,
  });
  await recordAudit(actorId, "ai.job_create", "ai_job", row.id, null, {
    topic: row.topic,
    requestedCount: row.requestedCount,
    model: row.model,
    coverageQuestions: digest.questionCount,
    coverageConcepts: digest.conceptCount,
    coverageTokens: digest.estimatedTokens,
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
  if (job.status === "succeeded" || job.status === "partial" || job.status === "failed") {
    throw conflict("That job has already finished.");
  }
  await db()
    .update(aiGenerationJobs)
    .set({ status: "cancelled", finishedAt: nowMs() })
    .where(eq(aiGenerationJobs.id, jobId));
  await recordAudit(actorId, "ai.job_cancel", "ai_job", jobId);
  return getJob(jobId);
}

function progressOf(job: AiGenerationJob, error: string | null = null): JobProgress {
  return {
    jobId: job.id,
    status: job.status,
    producedCount: job.producedCount,
    validCount: job.validCount,
    duplicateCount: job.duplicateCount,
    done: ["succeeded", "partial", "failed", "cancelled"].includes(job.status),
    error,
  };
}

// ── the two steps ────────────────────────────────────────────────────────────

/**
 * Advance a job by exactly one step. Safe to call repeatedly: a terminal job is
 * returned unchanged, so a retry or a double-click cannot double-generate.
 */
export async function runGenerationStep(
  jobId: string,
  deps: GenerationDeps,
): Promise<JobProgress> {
  const job = await getJob(jobId);
  logInfo("ai", `runGenerationStep ${jobId}`, { status: job.status });

  if (["succeeded", "partial", "failed", "cancelled"].includes(job.status)) {
    logWarn("ai", `step called on terminal job ${jobId}`, { status: job.status });
    return progressOf(job);
  }

  if (job.status === "queued") {
    return generateStage(job, deps);
  }

  return ingestStage(job, deps);
}

/** Step 1 — the LLM call. The slow one, but it is a single outbound request. */
async function generateStage(job: AiGenerationJob, deps: GenerationDeps): Promise<JobProgress> {
  const startedAt = nowMs();
  logInfo("ai", `step 1/2 generate for ${job.id}`, {
    provider: deps.provider.name,
    topic: job.topic,
    coverageTokens: job.coverageTokens,
  });
  const system = buildSystemPrompt();
  const user = buildUserPrompt({
    topic: job.topic,
    subtopics: job.subtopics ? (JSON.parse(job.subtopics) as string[]) : null,
    difficulty: job.difficulty,
    examBody: null,
    count: job.requestedCount,
    brief: job.brief,
    coverageDigest: job.coverageDigest,
    avoidTopics: job.avoidTopics ? (JSON.parse(job.avoidTopics) as string[]) : null,
  });

  try {
    const response = await deps.provider.generate({
      model: job.model,
      system,
      user,
      temperature: job.temperature ?? 0.7,
      maxTokens: 8000,
      providerOnly: job.providerOnly ? (JSON.parse(job.providerOnly) as string[]) : undefined,
      providerOrder: job.providerOrder ? (JSON.parse(job.providerOrder) as string[]) : undefined,
    });

    const key = `ai-jobs/${job.id}/response.txt`;
    await deps.storage.put(key, response.text);

    await db()
      .update(aiGenerationJobs)
      .set({
        status: "running",
        startedAt,
        rawResponseKey: key,
        promptTokens: response.promptTokens,
        completionTokens: response.completionTokens,
        costUsd: estimateCostUsd(job.model, response.promptTokens, response.completionTokens),
      })
      .where(eq(aiGenerationJobs.id, job.id));

    logInfo("ai", `step 1/2 done for ${job.id}`, {
      status: "running",
      rawResponseKey: key,
      promptTokens: response.promptTokens,
      completionTokens: response.completionTokens,
      costUsd: estimateCostUsd(job.model, response.promptTokens, response.completionTokens),
      durationMs: nowMs() - startedAt,
      outputBytes: response.text.length,
    });

    return progressOf(await getJob(job.id));
  } catch (error) {
    const message =
      error instanceof LlmError ? error.message : "The model provider call failed.";
    const code = error instanceof LlmError ? error.code : "PROVIDER_ERROR";
    logException("ai", `step 1/2 FAILED for ${job.id}`, error);
    logWarn("ai", `job ${job.id} marked failed`, { code, message });

    await db()
      .update(aiGenerationJobs)
      .set({ status: "failed", errorCode: code, errorMessage: message, finishedAt: nowMs() })
      .where(eq(aiGenerationJobs.id, job.id));

    await recordAudit(job.createdBy, "ai.job_failed", "ai_job", job.id, null, { code, message });
    return progressOf(await getJob(job.id), message);
  }
}

/** Step 2 — parse, validate, dedupe, store. Fast and deterministic. */
async function ingestStage(job: AiGenerationJob, deps: GenerationDeps): Promise<JobProgress> {
  logInfo("ai", `step 2/2 ingest for ${job.id}`, { rawResponseKey: job.rawResponseKey });
  if (!job.rawResponseKey) {
    logError("ai", `step 2/2 ${job.id}: no raw response key`);
    await failJob(job.id, "MISSING_RAW", "The job has no stored model response to process.");
    return progressOf(await getJob(job.id), "The job has no stored model response to process.");
  }

  const text = await deps.storage.get(job.rawResponseKey);
  logInfo("ai", `step 2/2 ${job.id}: read raw response`, { bytes: text?.length ?? 0 });
  if (text == null) {
    await failJob(job.id, "MISSING_RAW", "The stored model response could not be read.");
    return progressOf(await getJob(job.id), "The stored model response could not be read.");
  }

  let parsed;
  try {
    parsed = parseGenerationResponse(text, job.topic);
  } catch (error) {
    const message =
      error instanceof GenerationParseError ? error.message : "The model response could not be parsed.";
    logException("ai", `step 2/2 ${job.id}: parse failed`, error);
    await failJob(job.id, "UNPARSEABLE", message);
    return progressOf(await getJob(job.id), message);
  }
  logInfo("ai", `step 2/2 ${job.id}: parsed`, {
    accepted: parsed.accepted.length,
    rejected: parsed.rejected.length,
  });

  // ── Validation, per candidate (one bad item must not sink the batch) ─────
  const valid: ParsedCandidate[] = [];
  const invalid: Array<{ index: number; errors: string[]; raw: unknown }> = [
    ...parsed.rejected,
  ];

  for (const candidate of parsed.accepted) {
    const { errors } = validateQuestion(candidate.draft);
    if (errors.length > 0) {
      invalid.push({
        index: candidate.index,
        errors: errors.map((e) => `${e.field}: ${e.message}`),
        raw: candidate.raw,
      });
    } else {
      valid.push(candidate);
    }
  }

  // ── Dedupe against the bank, in ONE query per chunk ──────────────────────
  const verdicts = await checkCandidates(
    valid.map((candidate) => ({
      stem: candidate.draft.stem,
      optionBodies: candidate.draft.options.map((o) => o.body),
    })),
    { semantic: deps.semantic },
  );

  const now = nowMs();
  const rows: Array<typeof aiCandidates.$inferInsert> = [];
  let duplicateCount = 0;

  for (const [i, candidate] of valid.entries()) {
    const verdict = verdicts[i]!;
    if (verdict.autoReject) duplicateCount++;

    rows.push({
      id: newId(),
      jobId: job.id,
      batchIndex: candidate.index,
      stem: candidate.draft.stem,
      optionsJson: JSON.stringify(candidate.draft.options),
      correctOptionKey: candidate.draft.correctOptionKey,
      explanation: candidate.draft.explanation ?? null,
      backstory: candidate.draft.backstory ?? null,
      difficulty: candidate.draft.difficulty ?? "medium",
      topic: candidate.draft.topic ?? job.topic,
      tags: candidate.draft.tags?.length ? JSON.stringify(candidate.draft.tags) : null,
      validationStatus: "valid",
      validationErrors: null,
      dedupeStatus: verdict.status,
      dedupeLayer: verdict.layer,
      dedupeBestMatchId: verdict.bestMatch?.questionId ?? null,
      dedupeSimilarity: verdict.bestMatch?.similarity ?? null,
      dedupeDetail: JSON.stringify({ degraded: verdict.degraded, allMatches: verdict.allMatches }),
      normalizedHash: verdict.normalizedHash,
      simhash: simhashHex(candidate.draft.stem),
      reviewStatus: "pending",
      createdAt: now,
    });
  }

  for (const reject of invalid) {
    rows.push({
      id: newId(),
      jobId: job.id,
      batchIndex: reject.index,
      stem: extractStem(reject.raw),
      optionsJson: JSON.stringify(extractOptions(reject.raw)),
      correctOptionKey: extractCorrectKey(reject.raw),
      explanation: null,
      backstory: null,
      difficulty: null,
      topic: job.topic,
      tags: null,
      validationStatus: "invalid",
      // Errors are stored and shown, never swallowed (§12.5).
      validationErrors: JSON.stringify(reject.errors),
      dedupeStatus: "pending",
      dedupeLayer: null,
      dedupeBestMatchId: null,
      dedupeSimilarity: null,
      dedupeDetail: null,
      normalizedHash: null,
      simhash: null,
      reviewStatus: "pending",
      createdAt: now,
    });
  }

  // 17 columns per row → keep each statement under the parameter ceiling.
  const perChunk = Math.max(1, Math.floor(MAX_BOUND_PARAMS / 17));
  for (let i = 0; i < rows.length; i += perChunk) {
    await db().insert(aiCandidates).values(rows.slice(i, i + perChunk));
  }

  const produced = rows.length;
  const status = produced === 0 ? "failed" : invalid.length > 0 ? "partial" : "succeeded";

  logInfo("ai", `step 2/2 done for ${job.id}`, {
    status,
    accepted: parsed.accepted.length,
    valid: valid.length,
    invalid: invalid.length,
    duplicates: duplicateCount,
    storedRows: rows.length,
    repair: parsed.repair ?? [],
    durationMs: job.startedAt ? now - job.startedAt : null,
  });

  await db()
    .update(aiGenerationJobs)
    .set({
      status,
      producedCount: produced,
      validCount: valid.length,
      duplicateCount,
      finishedAt: now,
      durationMs: job.startedAt ? now - job.startedAt : null,
      errorCode: produced === 0 ? "NO_CANDIDATES" : null,
      errorMessage:
        produced === 0 ? "The model returned no usable questions." : null,
    })
    .where(eq(aiGenerationJobs.id, job.id));

  await recordAudit(job.createdBy, "ai.job_finished", "ai_job", job.id, null, {
    produced,
    valid: valid.length,
    duplicates: duplicateCount,
    invalid: invalid.length,
    repair: parsed.repair,
  });

  return progressOf(await getJob(job.id));
}

async function failJob(jobId: string, code: string, message: string): Promise<void> {
  logError("ai", `job ${jobId} failed`, { code, message });
  await db()
    .update(aiGenerationJobs)
    .set({ status: "failed", errorCode: code, errorMessage: message, finishedAt: nowMs() })
    .where(eq(aiGenerationJobs.id, jobId));
}

/** Best-effort field recovery from a malformed candidate, for the review UI. */
function extractStem(raw: unknown): string {
  if (raw && typeof raw === "object" && typeof (raw as { stem?: unknown }).stem === "string") {
    return (raw as { stem: string }).stem.slice(0, 500);
  }
  return "(the model's output for this question could not be read)";
}

function extractOptions(raw: unknown): Array<{ key: string; body: string }> {
  if (raw && typeof raw === "object") {
    const options = (raw as { options?: unknown }).options;
    if (Array.isArray(options)) {
      return options
        .filter((o): o is Record<string, unknown> => typeof o === "object" && o !== null)
        .map((o) => ({ key: String(o.key ?? "?"), body: String(o.body ?? "") }));
    }
  }
  return [];
}

function extractCorrectKey(raw: unknown): string {
  if (raw && typeof raw === "object") {
    const key = (raw as { correct_option_key?: unknown }).correct_option_key;
    if (typeof key === "string" && ["A", "B", "C", "D", "E"].includes(key)) return key;
  }
  // The column is NOT NULL; an invalid placeholder keeps the row visible.
  return "A";
}

// ── candidates: review and promotion ─────────────────────────────────────────

export type CandidateWithJob = AiCandidate & { model: string; jobTopic: string };

export async function listCandidates(
  options: { jobId?: string; reviewStatus?: string; limit?: number } = {},
): Promise<CandidateWithJob[]> {
  const filters = [];
  if (options.jobId) filters.push(eq(aiCandidates.jobId, options.jobId));
  if (options.reviewStatus) filters.push(eq(aiCandidates.reviewStatus, options.reviewStatus));

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

export async function getCandidate(id: string): Promise<AiCandidate> {
  const row = (await db().select().from(aiCandidates).where(eq(aiCandidates.id, id)).limit(1))[0];
  if (!row) throw notFound("Candidate not found.");
  return row;
}

export async function reviewCandidate(
  id: string,
  action: "approved" | "rejected" | "merged" | "deferred",
  actorId: string,
  note?: string | null,
): Promise<AiCandidate> {
  await getCandidate(id);
  await db()
    .update(aiCandidates)
    .set({
      reviewStatus: action,
      reviewedBy: actorId,
      reviewedAt: nowMs(),
      reviewNote: note?.trim() || null,
    })
    .where(eq(aiCandidates.id, id));

  await recordAudit(actorId, `ai.candidate_${action}`, "ai_candidate", id);
  return getCandidate(id);
}

export async function bulkReviewCandidates(
  ids: string[],
  action: "approved" | "rejected" | "deferred",
  actorId: string,
): Promise<{ updated: number; failed: Array<{ id: string; reason: string }> }> {
  const unique = [...new Set(ids)].filter(Boolean);
  if (unique.length === 0) return { updated: 0, failed: [] };

  const existing = new Set<string>();
  for (let i = 0; i < unique.length; i += MAX_BOUND_PARAMS) {
    const chunk = unique.slice(i, i + MAX_BOUND_PARAMS);
    const rows = await db().select({ id: aiCandidates.id }).from(aiCandidates).where(inArray(aiCandidates.id, chunk));
    for (const row of rows) existing.add(row.id);
  }

  const targets = unique.filter((id) => existing.has(id));
  const now = nowMs();
  for (let i = 0; i < targets.length; i += MAX_BOUND_PARAMS) {
    const chunk = targets.slice(i, i + MAX_BOUND_PARAMS);
    await db()
      .update(aiCandidates)
      .set({ reviewStatus: action, reviewedBy: actorId, reviewedAt: now })
      .where(inArray(aiCandidates.id, chunk));
  }

  await recordAudit(actorId, "ai.candidate_bulk_review", "ai_candidate", null, null, {
    requested: unique.length,
    updated: targets.length,
    action,
  });

  return {
    updated: targets.length,
    failed: unique.filter((id) => !existing.has(id)).map((id) => ({ id, reason: "No such candidate." })),
  };
}

/**
 * Promote an approved candidate into the real question bank.
 *
 * This is the ONLY path from an AI candidate to `questions` (§2.2). It calls
 * `createQuestion()`, so the promoted question passes the same validation and
 * duplicate funnel as anything typed by hand — and a duplicate that slipped
 * through as a candidate is rejected here.
 */
export async function promoteCandidate(
  id: string,
  actorId: string,
  options: { status?: QuestionStatus } = {},
): Promise<{ candidate: AiCandidate; questionId: string }> {
  const candidate = await getCandidate(id);

  if (candidate.promotedQuestionId) {
    throw conflict("That candidate has already been added to the bank.");
  }
  if (candidate.reviewStatus === "rejected") {
    throw conflict("That candidate was rejected. Approve it first if you changed your mind.");
  }
  if (candidate.validationStatus !== "valid") {
    throw conflict("That candidate did not pass validation and cannot be promoted.");
  }

  // NOTE: named `parsedOptions`, not `options` — the parameter above already
  // owns that name, and shadowing it silently drops the requested status.
  const parsedOptions: Array<{ key: "A" | "B" | "C" | "D" | "E"; body: string }> = JSON.parse(
    candidate.optionsJson,
  );

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

  const { question } = await createQuestion(draft, actorId, {
    // The human review IS the approval, so the question arrives approved but
    // NOT published — publishing stays a separate, deliberate action.
    status: options.status ?? "approved",
    origin: "ai",
  });

  await db()
    .update(aiCandidates)
    .set({
      promotedQuestionId: question.id,
      reviewStatus: "approved",
      reviewedBy: actorId,
      reviewedAt: nowMs(),
    })
    .where(eq(aiCandidates.id, id));

  await recordAudit(actorId, "ai.candidate_promoted", "ai_candidate", id, null, {
    questionId: question.id,
  });

  return { candidate: await getCandidate(id), questionId: question.id };
}

/** Review-queue depth, for the admin nav badge. */
export async function pendingReviewCount(): Promise<number> {
  const row = (
    await db()
      .select({ n: sql<number>`count(*)` })
      .from(aiCandidates)
      .where(eq(aiCandidates.reviewStatus, "pending"))
  )[0];
  return Number(row?.n ?? 0);
}

// ── acceptance-rate reporting (M13) ──────────────────────────────────────────

/**
 * How well is a given PROMPT doing?
 *
 * `prompt_version` is stamped on every job, so the only honest way to judge a
 * prompt change is to compare the human decisions made on the candidates it
 * produced. Without this, "the new prompt feels better" is the entire argument
 * for a change that costs real money.
 *
 * Two deliberate definitions:
 *
 *   acceptanceRate = approved / (approved + rejected + merged)
 *     ONLY decided candidates count. Deferred and pending are excluded rather
 *     than counted as rejections — a reviewer who has not looked yet is not
 *     evidence against the prompt, and folding them in would make the number
 *     sink whenever the queue is long.
 *
 *   duplicateRate = duplicates / produced
 *     Duplicates are the specific failure that coverage-aware generation is
 *     supposed to reduce, so it is reported next to acceptance rather than
 *     buried in it.
 *
 * A candidate can be BOTH a duplicate and ultimately approved (a reviewer may
 * accept a near-duplicate deliberately), so the two rates do not sum to 1.
 */
export type PromptVersionStats = {
  promptVersion: string;
  jobs: number;
  produced: number;
  valid: number;
  duplicates: number;
  approved: number;
  rejected: number;
  merged: number;
  deferred: number;
  pending: number;
  /** approved / decided, or null when nothing has been decided yet. */
  acceptanceRate: number | null;
  duplicateRate: number;
};

const DUPLICATE_STATUSES = "('exact_dup','near_dup','semantic_dup')";

export async function promptVersionStats(): Promise<PromptVersionStats[]> {
  const rows = await db()
    .select({
      promptVersion: aiGenerationJobs.promptVersion,
      jobs: sql<number>`count(distinct ${aiGenerationJobs.id})`,
      produced: sql<number>`count(${aiCandidates.id})`,
      valid: sql<number>`coalesce(sum(case when ${aiCandidates.validationStatus} = 'valid' then 1 else 0 end), 0)`,
      duplicates: sql<number>`coalesce(sum(case when ${aiCandidates.dedupeStatus} in ${sql.raw(DUPLICATE_STATUSES)} then 1 else 0 end), 0)`,
      approved: sql<number>`coalesce(sum(case when ${aiCandidates.reviewStatus} = 'approved' then 1 else 0 end), 0)`,
      rejected: sql<number>`coalesce(sum(case when ${aiCandidates.reviewStatus} = 'rejected' then 1 else 0 end), 0)`,
      merged: sql<number>`coalesce(sum(case when ${aiCandidates.reviewStatus} = 'merged' then 1 else 0 end), 0)`,
      deferred: sql<number>`coalesce(sum(case when ${aiCandidates.reviewStatus} = 'deferred' then 1 else 0 end), 0)`,
      pending: sql<number>`coalesce(sum(case when ${aiCandidates.reviewStatus} = 'pending' then 1 else 0 end), 0)`,
    })
    .from(aiGenerationJobs)
    // LEFT JOIN: a job that produced nothing is still a data point about the
    // prompt — dropping it would make a broken prompt look like a small one.
    .leftJoin(aiCandidates, eq(aiCandidates.jobId, aiGenerationJobs.id))
    .groupBy(aiGenerationJobs.promptVersion)
    .orderBy(desc(sql`count(${aiCandidates.id})`));

  return rows.map((row) => {
    const produced = Number(row.produced);
    const approved = Number(row.approved);
    const rejected = Number(row.rejected);
    const merged = Number(row.merged);
    const decided = approved + rejected + merged;

    return {
      promptVersion: row.promptVersion,
      jobs: Number(row.jobs),
      produced,
      valid: Number(row.valid),
      duplicates: Number(row.duplicates),
      approved,
      rejected,
      merged,
      deferred: Number(row.deferred),
      pending: Number(row.pending),
      acceptanceRate: decided === 0 ? null : approved / decided,
      duplicateRate: produced === 0 ? 0 : Number(row.duplicates) / produced,
    };
  });
}
