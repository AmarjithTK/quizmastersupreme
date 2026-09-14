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
import { checkCandidates } from "@/modules/dedupe";
import { computeDedupeHashes, createQuestion, validateQuestion, type QuestionDraft } from "@/modules/questions";
import { getDedupeThresholds } from "@/modules/settings";
import {
  GenerationParseError,
  parseGenerationResponse,
  type ParsedCandidate,
} from "./parse";
import { buildSystemPrompt, buildUserPrompt, PROMPT_VERSION } from "./prompts/generate";
import { estimateCostUsd, LlmError, type LlmProvider } from "./provider";
import { outputBudgetFor } from "./budget";
import { buildCoverageDigest } from "./coverage";

const MAX_BOUND_PARAMS = 90;
/** Hard ceiling on questions per job. */
export const MAX_REQUESTED = 50;
/** Model calls per job: the first ask plus this many backfill rounds. */
export const MAX_BACKFILL_ROUNDS = 3;

export type RawStorage = {
  put(key: string, value: string): Promise<void>;
  get(key: string): Promise<string | null>;
};

export type GenerationDeps = {
  provider: LlmProvider;
  storage: RawStorage;
};

export type JobProgress = {
  jobId: string;
  status: string;
  /** What the admin asked for. */
  requestedCount: number;
  /** Fresh, unique questions produced so far. */
  producedCount: number;
  validCount: number;
  /** Duplicates auto-filtered (never stored). */
  duplicateCount: number;
  /** Which model call this job is on (1-based once it has run). */
  round: number;
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
  /** Who/what the questions are for (audience or exam). */
  target?: string | null;
  /** Authoritative references the model must stay within. */
  sources?: string | null;
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
    coverageDigest: digest.text || null,
    coverageTokens: digest.estimatedTokens,
    includeExamples: input.includeExamples ? 1 : 0,
    status: "queued",
    producedCount: 0,
    validCount: 0,
    duplicateCount: 0,
    backfillRound: 0,
    duplicateSkipped: 0,
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
    .set({ status: "cancelled", finishedAt: nowMs() })
    .where(eq(aiGenerationJobs.id, jobId));
  await recordAudit(actorId, "ai.job_cancel", "ai_job", jobId);
  return getJob(jobId);
}

const TERMINAL_STATUSES = ["succeeded", "partial", "failed", "cancelled"];

function progressOf(job: AiGenerationJob, error: string | null = null): JobProgress {
  return {
    jobId: job.id,
    status: job.status,
    requestedCount: job.requestedCount,
    producedCount: job.producedCount,
    validCount: job.validCount,
    duplicateCount: job.duplicateCount,
    round: job.backfillRound,
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

  return generateRound(job, deps);
}

/**
 * One model call: ask for the shortfall, validate, flag duplicates against the
 * whole bank (stored, rejected by default), and stop at the requested count or
 * after MAX_BACKFILL_ROUNDS.
 */
async function generateRound(job: AiGenerationJob, deps: GenerationDeps): Promise<JobProgress> {
  const round = job.backfillRound + 1;
  const remaining = Math.max(0, job.requestedCount - job.producedCount);

  if (remaining <= 0) {
    await db()
      .update(aiGenerationJobs)
      .set({ status: "succeeded", finishedAt: nowMs() })
      .where(eq(aiGenerationJobs.id, job.id));
    return progressOf(await getJob(job.id));
  }

  // What this batch has already produced, fed back so the model cannot repeat
  // it. This is what makes the backfill rounds add FRESH questions.
  const existing = await listCandidates({ jobId: job.id, limit: 200 });
  const acceptedBlock =
    existing.length > 0
      ? [
          "",
          "ALREADY GENERATED IN THIS BATCH (do NOT repeat these):",
          ...existing.map((candidate) => `- ${candidate.stem}`),
        ].join("\n")
      : "";
  const digest = `${job.coverageDigest ?? ""}${acceptedBlock}`;

  const system = buildSystemPrompt();
  const user = buildUserPrompt({
    topic: job.topic,
    target: job.target,
    sources: job.sources,
    subtopics: parseJsonArray(job.subtopics),
    difficulty: job.difficulty,
    examBody: null,
    count: remaining,
    brief: job.brief,
    coverageDigest: digest,
    avoidTopics: parseJsonArray(job.avoidTopics),
  });

  const maxTokens = outputBudgetFor(remaining, job.model);
  const startedAt = nowMs();

  logInfo("ai", `round ${round}/${MAX_BACKFILL_ROUNDS} for ${job.id}`, {
    model: job.model,
    asking: remaining,
    maxTokens,
    existingInBatch: existing.length,
  });

  let response;
  try {
    response = await deps.provider.generate({
      model: job.model,
      system,
      user,
      temperature: job.temperature ?? 0.7,
      maxTokens,
      providerOnly: parseJsonArray(job.providerOnly) ?? undefined,
      providerOrder: parseJsonArray(job.providerOrder) ?? undefined,
    });
  } catch (error) {
    const message = error instanceof LlmError ? error.message : "The model provider call failed.";
    const code = error instanceof LlmError ? error.code : "PROVIDER_ERROR";
    logException("ai", `round ${round} FAILED for ${job.id}`, error);
    await failJob(job.id, code, message);
    return progressOf(await getJob(job.id), message);
  }

  const key = `ai-jobs/${job.id}/response-r${round}.txt`;
  try {
    await deps.storage.put(key, response.text);
  } catch (error) {
    // Archiving is diagnostic, not correctness — a failed R2 write must not
    // lose an otherwise good batch, but it IS logged.
    logException("ai", `could not archive raw response for ${job.id}`, error);
  }

  let parsed;
  try {
    parsed = parseGenerationResponse(response.text, job.topic);
  } catch (error) {
    const message =
      error instanceof GenerationParseError ? error.message : "The model response could not be parsed.";
    logException("ai", `round ${round} parse failed for ${job.id}`, error);
    await failJob(job.id, "UNPARSEABLE", message);
    return progressOf(await getJob(job.id), message);
  }

  // ── Validate each candidate; one bad item must not sink the batch ────────
  const valid: ParsedCandidate[] = [];
  for (const candidate of parsed.accepted) {
    const { errors } = validateQuestion(candidate.draft);
    if (errors.length === 0) valid.push(candidate);
  }

  // ── Compare against the WHOLE bank (every saved question, in any Q Set) ──
  const thresholds = await getDedupeThresholds();
  const verdicts = await checkCandidates(
    valid.map((candidate) => ({
      stem: candidate.draft.stem,
      optionBodies: candidate.draft.options.map((option) => option.body),
    })),
    { thresholds },
  );

  /**
   * Nothing is dropped here. A duplicate is STORED and arrives rejected by
   * default, carrying the question it matched and the reason — so the reviewer
   * can see it, judge it, and accept it if they disagree.
   *
   * `batchHashes` catches what the bank check cannot: a question this same job
   * produced in an earlier round, or earlier in this round.
   */
  const batchHashes = await loadBatchHashes(job.id);
  const now = nowMs();
  let nextIndex = existing.length;
  const rows: Array<typeof aiCandidates.$inferInsert> = [];
  let flagged = 0;

  for (const [index, candidate] of valid.entries()) {
    const verdict = verdicts[index]!;
    const mate = batchHashes.get(verdict.normalizedHash);

    let dedupeStatus = verdict.status;
    let matchedQuestionId: string | null = verdict.bestMatch?.questionId ?? null;
    let matchedStem: string | null = verdict.bestMatch?.stem ?? null;
    let similarity: number | null = verdict.bestMatch?.similarity ?? null;
    let reason: string | null = null;
    const percent = (value: number | null) =>
      value == null ? "" : ` (${Math.round(value * 100)}% match)`;

    if (mate) {
      // Same job, earlier question — a bank lookup cannot see these yet.
      dedupeStatus = "exact_dup";
      matchedQuestionId = null;
      matchedStem = mate.stem;
      similarity = 1;
      reason = `Already produced in this batch as Q${(mate.batchIndex ?? 0) + 1}.`;
    } else if (dedupeStatus === "exact_dup") {
      reason = "Identical to a question already in the bank.";
    } else if (dedupeStatus === "near_dup") {
      reason = `Almost certainly a duplicate of an existing bank question${percent(similarity)}.`;
    } else if (dedupeStatus === "possible_dup") {
      reason = `Looks similar to an existing bank question${percent(similarity)} — check it before keeping.`;
    }

    // Rejected by default unless it is clearly unique.
    const rejected = dedupeStatus === "clean" ? 0 : 1;
    if (rejected === 1) flagged++;

    const batchIndex = nextIndex++;
    rows.push({
      id: newId(),
      jobId: job.id,
      batchIndex,
      stem: candidate.draft.stem,
      optionsJson: JSON.stringify(candidate.draft.options),
      correctOptionKey: candidate.draft.correctOptionKey,
      explanation: candidate.draft.explanation ?? null,
      backstory: candidate.draft.backstory ?? null,
      difficulty: candidate.draft.difficulty ?? "medium",
      topic: candidate.draft.topic ?? job.topic,
      tags: candidate.draft.tags?.length ? JSON.stringify(candidate.draft.tags) : null,
      rejected,
      dedupeStatus,
      dedupeMatchedQuestionId: matchedQuestionId,
      dedupeMatchedStem: matchedStem,
      dedupeSimilarity: similarity,
      dedupeReason: reason,
      createdAt: now,
    });

    // Later questions in this round compare against this one.
    batchHashes.set(verdict.normalizedHash, { stem: candidate.draft.stem, batchIndex });
  }

  // D1's ~100 bound-parameter ceiling; derive the chunk from the real column
  // count so adding a column can never silently break the insert.
  const columnsPerRow = Object.keys(aiCandidates).length;
  const perChunk = Math.max(1, Math.floor(MAX_BOUND_PARAMS / Math.max(1, columnsPerRow)));
  for (let i = 0; i < rows.length; i += perChunk) {
    await db().insert(aiCandidates).values(rows.slice(i, i + perChunk));
  }

  const produced = job.producedCount + rows.length;
  const duplicateTotal = job.duplicateCount + flagged;
  const promptTokens = (job.promptTokens ?? 0) + (response.promptTokens ?? 0);
  const completionTokens = (job.completionTokens ?? 0) + (response.completionTokens ?? 0);
  const exhausted = round >= MAX_BACKFILL_ROUNDS;

  let status: string;
  let errorCode: string | null = null;
  let errorMessage: string | null = null;

  if (produced >= job.requestedCount) {
    status = "succeeded";
  } else if (!exhausted) {
    // The model returned FEWER questions than asked (truncation); another round
    // asks only for the remainder. Duplicates are never topped up — they stay
    // visible and rejected.
    status = "running";
  } else if (produced === 0) {
    status = "failed";
    errorCode = "NO_CANDIDATES";
    errorMessage = "The model returned no usable questions.";
  } else {
    status = "partial";
    errorCode = "SHORTFALL";
    errorMessage = `Produced ${produced} of ${job.requestedCount} after ${round} rounds.`;
  }

  await db()
    .update(aiGenerationJobs)
    .set({
      status,
      producedCount: produced,
      validCount: produced,
      duplicateCount: duplicateTotal,
      duplicateSkipped: duplicateTotal,
      backfillRound: round,
      rawResponseKey: key,
      promptTokens,
      completionTokens,
      costUsd: estimateCostUsd(job.model, promptTokens, completionTokens),
      startedAt: job.startedAt ?? startedAt,
      finishedAt: status === "running" ? null : now,
      durationMs: job.startedAt ? now - job.startedAt : now - startedAt,
      errorCode,
      errorMessage,
    })
    .where(eq(aiGenerationJobs.id, job.id));

  logInfo("ai", `round ${round} done for ${job.id}`, {
    status,
    asked: remaining,
    stored: rows.length,
    flaggedAsDuplicate: flagged,
    producedTotal: produced,
    requested: job.requestedCount,
    maxTokens,
    completionTokens: response.completionTokens,
    outputBytes: response.text.length,
  });

  await recordAudit(job.createdBy, "ai.job_round", "ai_job", job.id, null, {
    round,
    asked: remaining,
    stored: rows.length,
    flaggedAsDuplicate: flagged,
    producedTotal: produced,
    status,
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

/** All candidates of a job in batch order — the review screen's payload. */
export async function listJobCandidates(jobId: string): Promise<CandidateWithJob[]> {
  const rows = await listCandidates({ jobId, limit: 200 });
  return rows.sort((a, b) => (a.batchIndex ?? 0) - (b.batchIndex ?? 0));
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
  await recordAudit(actorId, rejected ? "ai.candidate_reject" : "ai.candidate_keep", "ai_candidate", id);
  return { ...candidate, rejected: rejected ? 1 : 0 };
}

// ── generation health, by prompt version ─────────────────────────────────────

export type PromptVersionStats = {
  promptVersion: string;
  jobs: number;
  requested: number;
  produced: number;
  duplicates: number;
  /** produced ÷ (produced + duplicates): how much of the output was usable. */
  freshRate: number;
};

export async function promptVersionStats(): Promise<PromptVersionStats[]> {
  const rows = await db()
    .select({
      promptVersion: aiGenerationJobs.promptVersion,
      jobs: sql<number>`count(*)`,
      requested: sql<number>`coalesce(sum(${aiGenerationJobs.requestedCount}), 0)`,
      produced: sql<number>`coalesce(sum(${aiGenerationJobs.producedCount}), 0)`,
      duplicates: sql<number>`coalesce(sum(${aiGenerationJobs.duplicateCount}), 0)`,
    })
    .from(aiGenerationJobs)
    .groupBy(aiGenerationJobs.promptVersion)
    .orderBy(desc(sql`coalesce(sum(${aiGenerationJobs.producedCount}), 0)`));

  return rows.map((row) => {
    const produced = Number(row.produced);
    const duplicates = Number(row.duplicates);
    const total = produced + duplicates;
    return {
      promptVersion: row.promptVersion,
      jobs: Number(row.jobs),
      requested: Number(row.requested),
      produced,
      duplicates,
      freshRate: total === 0 ? 1 : produced / total,
    };
  });
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
  },
): Promise<CommitOutcome> {
  const job = await getJob(jobId);
  if (job.committedAt != null) {
    throw conflict("This batch has already been added to a Q Set.");
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

  const candidates = (await listJobCandidates(jobId)).filter((candidate) => candidate.rejected === 0);

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
    duplicateOverrides,
    attached,
    attachSkipped,
    failed: failed.length,
  });

  logInfo("ai", `job ${jobId} committed`, {
    setId,
    createdSet: createdSet?.id ?? null,
    promoted: promoted.length,
    duplicateOverrides,
    attached,
    failed: failed.length,
  });

  return { jobId, promoted, failed, createdSet, newSetId: createdSet?.id ?? null, questionIds };
}
