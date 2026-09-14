/**
 * Questions service — owns `questions` and `question_options`.
 * PLAN.md §7.2.
 *
 * `createQuestion` is THE FUNNEL (§2.9). Manual authoring, CSV import and (from
 * M10) AI promotion all call it, so validation and duplicate detection cannot
 * be bypassed by any one path.
 *
 * The write is a single `db.batch()`: the question row and its options land
 * together or not at all. The database's partial unique index
 * (ux_question_options_single_correct) is the backstop if anything ever sends
 * two correct options.
 */

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { db } from "@/db/client";
import {
  newId,
  nowMs,
  questionOptions,
  questions,
  questionSetQuestions,
  type OptionKey,
  type Question,
  type QuestionStatus,
} from "@/db/schema";
import { ApiError, notFound, validationError } from "@/lib/errors";
import { recordAudit } from "@/modules/audit";
import { checkCandidate, type SemanticDedupe } from "@/modules/dedupe";
import { simhashHex } from "@/modules/dedupe/simhash";
import { normalizeStem } from "./normalize";
import {
  validateQuestion,
  type QuestionDraft,
  type ValidationIssue,
} from "./validation";

export type QuestionWriteResult = {
  question: Question;
  warnings: ValidationIssue[];
};

/** Drizzle column types are `string` even with CHECK constraints. */
const QUESTION_STATUSES: readonly QuestionStatus[] = [
  "ai_draft",
  "draft",
  "review",
  "approved",
  "published",
  "rejected",
  "duplicate",
  "archived",
];

/**
 * Ceiling on how many FTS hits feed a filtered query.
 *
 * Hits are bm25-ranked before the cap, so this keeps the most relevant rows
 * rather than an arbitrary slice. Beyond it, the admin should narrow the search.
 */
const MAX_FTS_CANDIDATES = 1000;

/** D1 caps bound parameters per statement at ~100; stay clearly under. */
const MAX_BOUND_PARAMS = 90;

// ── read helpers ─────────────────────────────────────────────────────────────

export type QuestionWithOptions = Question & {
  options: Array<{ id: string; key: OptionKey; body: string; isCorrect: number; sortOrder: number }>;
};

export async function getQuestionForAdmin(id: string): Promise<QuestionWithOptions> {
  const question = (await db().select().from(questions).where(eq(questions.id, id)).limit(1))[0];
  if (!question) throw notFound("Question not found.");

  const options = await db()
    .select({
      id: questionOptions.id,
      key: questionOptions.optionKey,
      body: questionOptions.body,
      isCorrect: questionOptions.isCorrect,
      sortOrder: questionOptions.sortOrder,
    })
    .from(questionOptions)
    .where(eq(questionOptions.questionId, id))
    .orderBy(questionOptions.sortOrder);

  return {
    ...question,
    options: options.map((o) => ({ ...o, key: o.key as OptionKey })),
  };
}

export type QuestionSummary = {
  id: string;
  stem: string;
  difficulty: string;
  topic: string | null;
  status: string;
  origin: string;
  year: number | null;
  examBody: string | null;
  hasBackstory: boolean;
  optionCount: number;
  setCount: number;
  createdAt: number;
};

export type QuestionFilters = {
  q?: string;
  status?: string;
  difficulty?: string;
  topic?: string;
  origin?: string;
  setId?: string;
  page?: number;
  pageSize?: number;
};

/**
 * Build an FTS5 MATCH expression from free text.
 *
 * Every term is double-quoted so user input can never be parsed as FTS syntax
 * (which would otherwise let a stray `*` or `"` produce a syntax error or an
 * unintended prefix query).
 *
 * The default joins terms with OR: a question bank SEARCH should broaden
 * recall, and bm25 ordering sorts the good hits to the top. Callers that need
 * precision instead — picking a topic's own prior questions — pass
 * `operator: "AND"`, where a single shared word ("systems") no longer drags in
 * an unrelated subject ("the Solar System"). See `modules/ai/coverage.ts`.
 */
export function buildFtsMatch(
  raw: string,
  options: { operator?: "OR" | "AND" } = {},
): string {
  const terms = raw
    .split(/\s+/)
    .map((term) => term.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter((term) => term.length > 1);

  if (terms.length === 0) return "";
  const operator = options.operator ?? "OR";
  return terms.map((term) => `"${term}"`).join(` ${operator} `);
}

export async function listQuestionsForAdmin(
  filters: QuestionFilters = {},
): Promise<{ rows: QuestionSummary[]; total: number; page: number; pageSize: number }> {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(100, Math.max(5, filters.pageSize ?? 20));

  const conditions = [];
  if (filters.status) conditions.push(eq(questions.status, filters.status));
  if (filters.difficulty) conditions.push(eq(questions.difficulty, filters.difficulty));
  if (filters.topic) conditions.push(eq(questions.topic, filters.topic));
  if (filters.origin) conditions.push(eq(questions.origin, filters.origin));

  if (filters.setId) {
    conditions.push(
      inArray(
        questions.id,
        db()
          .select({ id: questionSetQuestions.questionId })
          .from(questionSetQuestions)
          .where(eq(questionSetQuestions.setId, filters.setId)),
      ),
    );
  }

  if (filters.q?.trim()) {
    const match = buildFtsMatch(filters.q);
    if (match) {
      /**
       * A SUBQUERY, not `inArray(ids)`.
       *
       * D1 allows ~100 bound parameters per statement. Feeding an FTS hit list
       * back through `inArray` produced one parameter PER HIT, so a broad search
       * over a large bank generated hundreds of parameters and the query failed
       * outright with "too many SQL variables".
       *
       * Passing the MATCH string as a single parameter and letting SQLite do the
       * ranking also means ORDER BY rank is applied to the candidate set itself,
       * so the cap keeps the BEST matches rather than an arbitrary slice.
       */
      conditions.push(
        sql`${questions.id} in (
          select question_id from questions_fts
          where questions_fts match ${match}
          order by rank
          limit ${MAX_FTS_CANDIDATES}
        )`,
      );
    }
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, countRow] = await Promise.all([
    db()
      .select({
        id: questions.id,
        stem: questions.stem,
        difficulty: questions.difficulty,
        topic: questions.topic,
        status: questions.status,
        origin: questions.origin,
        year: questions.year,
        examBody: questions.examBody,
        hasBackstory: sql<number>`case when ${questions.backstory} is null or ${questions.backstory} = '' then 0 else 1 end`,
        optionCount: sql<number>`(select count(*) from question_options qo where qo.question_id = ${questions.id})`,
        setCount: sql<number>`(select count(*) from question_set_questions qsq where qsq.question_id = ${questions.id})`,
        createdAt: questions.createdAt,
      })
      .from(questions)
      .where(where)
      .orderBy(desc(questions.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db().select({ n: sql<number>`count(*)` }).from(questions).where(where),
  ]);

  return {
    rows: rows.map((row) => ({
      ...row,
      hasBackstory: Number(row.hasBackstory) === 1,
      optionCount: Number(row.optionCount ?? 0),
      setCount: Number(row.setCount ?? 0),
    })),
    total: Number(countRow[0]?.n ?? 0),
    page,
    pageSize,
  };
}

// ── write paths ──────────────────────────────────────────────────────────────

export type CreateQuestionOptions = {
  status?: QuestionStatus;
  origin?: "manual" | "ai" | "import" | "seed";
  createdBy?: string | null;
  generationJobId?: string | null;
  /**
   * Layer 3 dependencies. Supplied by the edge route when the Workers AI and
   * Vectorize bindings exist; absent means layer 3 is skipped and reported as
   * degraded rather than assumed clean.
   */
  semantic?: SemanticDedupe | null;
};

function assertValid(draft: QuestionDraft): { warnings: ValidationIssue[]; language: string } {
  const { errors, warnings, language } = validateQuestion(draft);
  if (errors.length > 0) {
    throw validationError(
      errors[0]!.message,
      errors.map((e) => ({ field: e.field, message: e.message })),
    );
  }
  return { warnings, language };
}

/**
 * Layer-1 duplicate gate. Returns the verdict so the caller can reuse the
 * computed hashes instead of hashing the same draft twice.
 */
async function guardDuplicate(
  draft: QuestionDraft,
  excludeQuestionId?: string,
  semantic?: SemanticDedupe | null,
) {
  const verdict = await checkCandidate(
    {
      stem: draft.stem,
      optionBodies: draft.options.map((o) => o.body),
      excludeQuestionId,
    },
    { semantic },
  );

  if (verdict.autoReject && verdict.bestMatch) {
    throw new ApiError("DUPLICATE", "This question already exists in the bank.", {
      matchedQuestionId: verdict.bestMatch.questionId,
      matchedStem: verdict.bestMatch.stem,
      layer: verdict.layer,
      similarity: verdict.bestMatch.similarity,
    });
  }
  return verdict;
}

function questionRow(
  draft: QuestionDraft,
  hashes: { normalizedHash: string; contentHash: string },
  language: string,
  options: CreateQuestionOptions,
  now: number,
): Question {
  return {
    id: newId(),
    stem: draft.stem.trim(),
    stemFormat: "markdown",
    explanation: draft.explanation?.trim() || null,
    backstory: draft.backstory?.trim() || null,
    backstoryFormat: "markdown",
    difficulty: draft.difficulty ?? "medium",
    topic: draft.topic?.trim() || null,
    tags: draft.tags && draft.tags.length > 0 ? JSON.stringify(draft.tags) : null,
    year: draft.year ?? null,
    source: draft.source?.trim() || null,
    sourceUrl: draft.sourceUrl?.trim() || null,
    examBody: draft.examBody?.trim() || null,
    language,
    status: options.status ?? "draft",
    normalizedHash: hashes.normalizedHash,
    contentHash: hashes.contentHash,
    simhash: simhashHex(draft.stem),
    origin: options.origin ?? "manual",
    createdBy: options.createdBy ?? null,
    generationJobId: options.generationJobId ?? null,
    approvedBy: null,
    approvedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function optionRows(questionId: string, draft: QuestionDraft) {
  return draft.options.map((option, index) => ({
    id: `${questionId}_${option.key}`,
    questionId,
    optionKey: option.key,
    body: option.body.trim(),
    isCorrect: option.key === draft.correctOptionKey ? 1 : 0,
    sortOrder: index,
  }));
}

export async function createQuestion(
  draft: QuestionDraft,
  actorId: string,
  options: CreateQuestionOptions = {},
): Promise<QuestionWriteResult> {
  const { warnings, language } = assertValid(draft);
  const verdict = await guardDuplicate(draft, undefined, options.semantic);

  const now = nowMs();
  const row = questionRow(
    draft,
    { normalizedHash: verdict.normalizedHash, contentHash: verdict.contentHash },
    language,
    { ...options, createdBy: options.createdBy ?? actorId },
    now,
  );

  // One batch: the question and its options land together or not at all.
  await db().batch([
    db().insert(questions).values(row),
    db().insert(questionOptions).values(optionRows(row.id, draft)),
  ] as unknown as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);

  await recordAudit(actorId, "question.create", "question", row.id, null, {
    stem: row.stem,
    status: row.status,
  });

  return { question: row, warnings };
}

export async function updateQuestion(
  id: string,
  patch: Partial<QuestionDraft>,
  actorId: string,
  options: { semantic?: SemanticDedupe | null } = {},
): Promise<QuestionWriteResult> {
  const existing = await getQuestionForAdmin(id);

  // Merge over the existing row so a partial patch still validates as a whole.
  const draft: QuestionDraft = {
    stem: patch.stem ?? existing.stem,
    options:
      patch.options ??
      existing.options.map((o) => ({ key: o.key, body: o.body })),
    correctOptionKey:
      patch.correctOptionKey ??
      (existing.options.find((o) => o.isCorrect === 1)?.key ?? ("A" as OptionKey)),
    explanation: patch.explanation !== undefined ? patch.explanation : existing.explanation,
    backstory: patch.backstory !== undefined ? patch.backstory : existing.backstory,
    difficulty: patch.difficulty ?? existing.difficulty,
    topic: patch.topic !== undefined ? patch.topic : existing.topic,
    tags:
      patch.tags !== undefined
        ? patch.tags
        : existing.tags
          ? (JSON.parse(existing.tags) as string[])
          : [],
    year: patch.year !== undefined ? patch.year : existing.year,
    examBody: patch.examBody !== undefined ? patch.examBody : existing.examBody,
    source: patch.source !== undefined ? patch.source : existing.source,
    sourceUrl: patch.sourceUrl !== undefined ? patch.sourceUrl : existing.sourceUrl,
  };

  const { warnings, language } = assertValid(draft);
  const verdict = await guardDuplicate(draft, id, options.semantic);
  const now = nowMs();

  await db().batch([
    db()
      .update(questions)
      .set({
        stem: draft.stem.trim(),
        explanation: draft.explanation?.trim() || null,
        backstory: draft.backstory?.trim() || null,
        difficulty: draft.difficulty ?? existing.difficulty,
        topic: draft.topic?.trim() || null,
        tags: draft.tags && draft.tags.length > 0 ? JSON.stringify(draft.tags) : null,
        year: draft.year ?? null,
        examBody: draft.examBody?.trim() || null,
        source: draft.source?.trim() || null,
        sourceUrl: draft.sourceUrl?.trim() || null,
        language,
        normalizedHash: verdict.normalizedHash,
        contentHash: verdict.contentHash,
        simhash: simhashHex(draft.stem),
        updatedAt: now,
      })
      .where(eq(questions.id, id)),
    db().delete(questionOptions).where(eq(questionOptions.questionId, id)),
    db().insert(questionOptions).values(optionRows(id, draft)),
  ] as unknown as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);

  await recordAudit(actorId, "question.update", "question", id, { stem: existing.stem }, {
    stem: draft.stem,
  });

  const question = (await db().select().from(questions).where(eq(questions.id, id)).limit(1))[0]!;
  return { question, warnings };
}

export async function setQuestionStatus(
  id: string,
  status: QuestionStatus,
  actorId: string,
): Promise<Question> {
  if (!QUESTION_STATUSES.includes(status)) {
    throw validationError(`Unknown status "${status}".`);
  }
  const before = (await db().select().from(questions).where(eq(questions.id, id)).limit(1))[0];
  if (!before) throw notFound("Question not found.");

  const now = nowMs();
  // Approving or publishing records WHO vouched for it — that is the whole
  // point of the review queue (§2.2).
  const approving = status === "approved" || status === "published";

  await db()
    .update(questions)
    .set({
      status,
      approvedBy: approving ? (before.approvedBy ?? actorId) : before.approvedBy,
      approvedAt: approving ? (before.approvedAt ?? now) : before.approvedAt,
      updatedAt: now,
    })
    .where(eq(questions.id, id));

  await recordAudit(actorId, "question.status", "question", id, { status: before.status }, { status });
  return (await db().select().from(questions).where(eq(questions.id, id)).limit(1))[0]!;
}

/** Archived, not deleted — attempts reference answers via question_id. */
export async function archiveQuestion(id: string, actorId: string): Promise<Question> {
  return setQuestionStatus(id, "archived", actorId);
}

/**
 * Bulk status change (M9).
 *
 * One UPDATE per chunk of ids rather than one per question, because the admin
 * UI lets you select a whole page. `coalesce` keeps the FIRST approval
 * attribution: re-publishing an already-approved question must not overwrite
 * who originally vouched for it (§2.2).
 *
 * NOTE ON COUNTING: D1's `meta.changes` is NOT the number of rows matched — it
 * counts physical writes including index entries, so updating ONE question with
 * six indexes reports 7. The affected ids are therefore resolved with a SELECT
 * first and the count comes from that, not from the driver.
 */
export async function bulkSetQuestionStatus(
  ids: string[],
  status: QuestionStatus,
  actorId: string,
): Promise<{ updated: number; failed: Array<{ id: string; reason: string }> }> {
  if (!QUESTION_STATUSES.includes(status)) {
    throw validationError(`Unknown status "${status}".`);
  }

  const unique = [...new Set(ids)].filter(Boolean);
  if (unique.length === 0) return { updated: 0, failed: [] };

  // Which of the requested ids actually exist?
  const existing = new Set<string>();
  for (let i = 0; i < unique.length; i += MAX_BOUND_PARAMS) {
    const chunk = unique.slice(i, i + MAX_BOUND_PARAMS);
    const rows = await db()
      .select({ id: questions.id })
      .from(questions)
      .where(inArray(questions.id, chunk));
    for (const row of rows) existing.add(row.id);
  }

  const approving = status === "approved" || status === "published";
  const now = nowMs();
  const targets = unique.filter((id) => existing.has(id));

  for (let i = 0; i < targets.length; i += MAX_BOUND_PARAMS) {
    const chunk = targets.slice(i, i + MAX_BOUND_PARAMS);
    await db()
      .update(questions)
      .set({
        status,
        approvedBy: approving
          ? sql`coalesce(${questions.approvedBy}, ${actorId})`
          : sql`${questions.approvedBy}`,
        approvedAt: approving
          ? sql`coalesce(${questions.approvedAt}, ${now})`
          : sql`${questions.approvedAt}`,
        updatedAt: now,
      })
      .where(inArray(questions.id, chunk));
  }

  await recordAudit(actorId, "question.bulk_status", "question", null, null, {
    requested: unique.length,
    updated: targets.length,
    status,
  });

  const failed = unique
    .filter((id) => !existing.has(id))
    .map((id) => ({ id, reason: "No question with that id exists." }));

  return { updated: targets.length, failed };
}

export { normalizeStem };
