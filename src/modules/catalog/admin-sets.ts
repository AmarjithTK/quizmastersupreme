/**
 * Admin mutations for quiz sets (M3).
 *
 * Quiz sets are DEPTH 2 — the terminal content node (§2.1). A set belongs to
 * exactly one category and holds questions via `question_set_questions`.
 *
 * `categoryId` is deliberately IMMUTABLE after creation: (category_id, slug) is
 * the uniqueness key, so moving a set between categories would need a slug
 * collision check against the destination. Moving is a later feature; until
 * then, create it in the right place.
 */

import { and, eq, ne } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { db } from "@/db/client";
import { categories, newId, nowMs, quizSets, type QuizSet } from "@/db/schema";
import { conflict, notFound, validationError } from "@/lib/errors";
import { recordAudit } from "@/modules/audit";
import { slugify } from "@/modules/questions/normalize";

export const SET_MODES = ["practice", "mock"] as const;
export const SET_DIFFICULTIES = ["easy", "medium", "hard", "expert", "mixed"] as const;
export const SET_STATUSES = ["draft", "published", "archived"] as const;

export type SetMode = (typeof SET_MODES)[number];
export type SetStatus = (typeof SET_STATUSES)[number];

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_TITLE = 120;
const MAX_GROUP_LABEL = 40;
const MIN_TIME_LIMIT = 30;
const MAX_TIME_LIMIT = 6 * 60 * 60;
const MAX_QUESTION_LIMIT = 1000;

export type CreateSetInput = {
  categoryId: string;
  title: string;
  slug?: string;
  description?: string | null;
  groupLabel?: string | null;
  mode?: SetMode;
  difficulty?: string;
  timeLimitSeconds?: number | null;
  questionLimit?: number | null;
  shuffleQuestions?: boolean;
  shuffleOptions?: boolean;
  passingPercent?: number | null;
  sortOrder?: number;
};

export type UpdateSetInput = Partial<Omit<CreateSetInput, "categoryId">> & {
  status?: SetStatus;
};

// ── validation ───────────────────────────────────────────────────────────────

function validateTitle(value: string): string {
  const title = value.trim();
  if (!title) throw validationError("Title is required.");
  if (title.length > MAX_TITLE) {
    throw validationError(`Title must be ${MAX_TITLE} characters or fewer.`);
  }
  return title;
}

function validateSlug(value: string): string {
  const slug = value.trim();
  if (!SLUG_PATTERN.test(slug)) {
    throw validationError("Slug must contain only lowercase letters, numbers and hyphens.");
  }
  return slug;
}

function validateGroupLabel(value: string | null | undefined): string | null {
  if (value == null) return null;
  const label = value.trim();
  if (!label) return null;
  if (label.length > MAX_GROUP_LABEL) {
    throw validationError(`Group label must be ${MAX_GROUP_LABEL} characters or fewer.`);
  }
  return label;
}

function validateMode(value: string | undefined): SetMode {
  const mode = value ?? "practice";
  if (!(SET_MODES as readonly string[]).includes(mode)) {
    throw validationError(`Mode must be one of: ${SET_MODES.join(", ")}.`);
  }
  return mode as SetMode;
}

function validateDifficulty(value: string | undefined): string {
  const difficulty = value ?? "medium";
  if (!(SET_DIFFICULTIES as readonly string[]).includes(difficulty)) {
    throw validationError(`Difficulty must be one of: ${SET_DIFFICULTIES.join(", ")}.`);
  }
  return difficulty;
}

/** NULL means untimed. */
function validateTimeLimit(value: number | null | undefined): number | null {
  if (value == null) return null;
  if (!Number.isInteger(value) || value < MIN_TIME_LIMIT || value > MAX_TIME_LIMIT) {
    throw validationError(
      `Time limit must be between ${MIN_TIME_LIMIT} and ${MAX_TIME_LIMIT} seconds, or empty for untimed.`,
    );
  }
  return value;
}

/** NULL means "serve every attached question". */
function validateQuestionLimit(value: number | null | undefined): number | null {
  if (value == null) return null;
  if (!Number.isInteger(value) || value < 1 || value > MAX_QUESTION_LIMIT) {
    throw validationError(`Question limit must be between 1 and ${MAX_QUESTION_LIMIT}, or empty for all.`);
  }
  return value;
}

function validatePassingPercent(value: number | null | undefined): number | null {
  if (value == null) return null;
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    throw validationError("Passing percentage must be between 0 and 100, or empty.");
  }
  return value;
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function getSet(id: string): Promise<QuizSet> {
  const row = (await db().select().from(quizSets).where(eq(quizSets.id, id)).limit(1))[0];
  if (!row) throw notFound("Quiz set not found.");
  return row;
}

async function assertCategoryExists(categoryId: string): Promise<void> {
  const row = (
    await db().select({ id: categories.id }).from(categories).where(eq(categories.id, categoryId)).limit(1)
  )[0];
  if (!row) throw notFound("That subject does not exist.");
}

/**
 * Slugs are unique per CATEGORY, not globally, so the check is scoped. The DB
 * enforces the same rule via uq_quiz_sets_category_slug — this just produces a
 * readable error instead of a constraint violation.
 */
async function assertSlugFree(categoryId: string, slug: string, exceptId?: string): Promise<void> {
  const conditions = [eq(quizSets.categoryId, categoryId), eq(quizSets.slug, slug)];
  if (exceptId) conditions.push(ne(quizSets.id, exceptId));

  const row = (
    await db()
      .select({ id: quizSets.id })
      .from(quizSets)
      .where(and(...conditions))
      .limit(1)
  )[0];

  if (row) throw conflict(`A set with the slug "${slug}" already exists in this subject.`);
}

// ── mutations ────────────────────────────────────────────────────────────────

export async function createSet(input: CreateSetInput, actorId: string): Promise<QuizSet> {
  await assertCategoryExists(input.categoryId);

  const title = validateTitle(input.title);
  const slug = validateSlug(input.slug?.trim() || slugify(title));
  await assertSlugFree(input.categoryId, slug);

  const now = nowMs();
  const row: QuizSet = {
    id: newId(),
    categoryId: input.categoryId,
    slug,
    title,
    description: input.description?.trim() || null,
    groupLabel: validateGroupLabel(input.groupLabel),
    mode: validateMode(input.mode),
    difficulty: validateDifficulty(input.difficulty),
    timeLimitSeconds: validateTimeLimit(input.timeLimitSeconds),
    questionLimit: validateQuestionLimit(input.questionLimit),
    shuffleQuestions: input.shuffleQuestions === false ? 0 : 1,
    shuffleOptions: input.shuffleOptions === true ? 1 : 0,
    passingPercent: validatePassingPercent(input.passingPercent),
    sortOrder: input.sortOrder ?? 0,
    status: "draft",
    publishedAt: null,
    createdAt: now,
    updatedAt: now,
  };

  await db().insert(quizSets).values(row);
  await recordAudit(actorId, "set.create", "quiz_set", row.id, null, row);
  return row;
}

export async function updateSet(
  id: string,
  patch: UpdateSetInput,
  actorId: string,
): Promise<QuizSet> {
  const before = await getSet(id);
  const updates: Partial<QuizSet> = {};

  if (patch.title !== undefined) updates.title = validateTitle(patch.title);
  if (patch.slug !== undefined) updates.slug = validateSlug(patch.slug);
  if (patch.description !== undefined) updates.description = patch.description?.trim() || null;
  if (patch.groupLabel !== undefined) updates.groupLabel = validateGroupLabel(patch.groupLabel);
  if (patch.mode !== undefined) updates.mode = validateMode(patch.mode);
  if (patch.difficulty !== undefined) updates.difficulty = validateDifficulty(patch.difficulty);
  if (patch.timeLimitSeconds !== undefined) {
    updates.timeLimitSeconds = validateTimeLimit(patch.timeLimitSeconds);
  }
  if (patch.questionLimit !== undefined) {
    updates.questionLimit = validateQuestionLimit(patch.questionLimit);
  }
  if (patch.shuffleQuestions !== undefined) updates.shuffleQuestions = patch.shuffleQuestions ? 1 : 0;
  if (patch.shuffleOptions !== undefined) updates.shuffleOptions = patch.shuffleOptions ? 1 : 0;
  if (patch.passingPercent !== undefined) {
    updates.passingPercent = validatePassingPercent(patch.passingPercent);
  }
  if (patch.sortOrder !== undefined) updates.sortOrder = patch.sortOrder;

  if (patch.status !== undefined) {
    if (!(SET_STATUSES as readonly string[]).includes(patch.status)) {
      throw validationError(`Status must be one of: ${SET_STATUSES.join(", ")}.`);
    }
    updates.status = patch.status;
    // Stamp publishedAt the first time it goes live; leave it alone afterwards
    // so re-publishing does not rewrite the original publication date.
    if (patch.status === "published" && before.publishedAt === null) {
      updates.publishedAt = nowMs();
    }
  }

  if (updates.slug && updates.slug !== before.slug) {
    await assertSlugFree(before.categoryId, updates.slug, id);
  }

  if (Object.keys(updates).length === 0) return before;

  await db()
    .update(quizSets)
    .set({ ...updates, updatedAt: nowMs() })
    .where(eq(quizSets.id, id));

  const after = await getSet(id);
  await recordAudit(actorId, "set.update", "quiz_set", id, before, after);
  return after;
}

export async function setSetStatus(id: string, status: SetStatus, actorId: string): Promise<QuizSet> {
  return updateSet(id, { status }, actorId);
}

/**
 * Sets are ARCHIVED, never dropped: `question_set_questions` cascades on delete,
 * so a hard delete would silently detach questions from every attempt history
 * that references the set.
 */
export async function archiveSet(id: string, actorId: string): Promise<QuizSet> {
  return updateSet(id, { status: "archived" }, actorId);
}

/** Reorder sets within their category. Ids from mixed categories are fine. */
export async function reorderSets(orderedIds: string[], actorId: string): Promise<void> {
  if (orderedIds.length === 0) return;
  const statements = orderedIds.map((id, index) =>
    db()
      .update(quizSets)
      .set({ sortOrder: index, updatedAt: nowMs() })
      .where(eq(quizSets.id, id)),
  ) as unknown as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]];
  await db().batch(statements);
  await recordAudit(actorId, "set.reorder", "quiz_set", null, null, { orderedIds });
}
