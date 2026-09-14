/**
 * HTTP body → domain input coercion for the quiz-set admin routes.
 *
 * Colocated with the routes because it is HTTP-shaped, not domain logic. The
 * domain service re-validates everything anyway; this only prevents `undefined`
 * and strings-of-numbers from reaching it.
 */

import type { CreateSetInput, SetMode, SetStatus, UpdateSetInput } from "@/modules/catalog";

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** undefined = absent, null = explicit clear, number = parsed value. */
function asNumberOrNull(value: unknown): number | null | undefined {
  if (value === null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

const PATCHABLE_STRING_KEYS = ["title", "slug", "description", "groupLabel", "mode", "difficulty"] as const;

function readCommon(body: Record<string, unknown>) {
  return {
    title: asString(body.title),
    slug: asString(body.slug),
    description: body.description === null ? null : asString(body.description),
    groupLabel: body.groupLabel === null ? null : asString(body.groupLabel),
    mode: asString(body.mode) as SetMode | undefined,
    difficulty: asString(body.difficulty),
    timeLimitSeconds: asNumberOrNull(body.timeLimitSeconds),
    questionLimit: asNumberOrNull(body.questionLimit),
    passingPercent: asNumberOrNull(body.passingPercent),
    shuffleQuestions: asBoolean(body.shuffleQuestions),
    shuffleOptions: asBoolean(body.shuffleOptions),
    sortOrder: asNumberOrNull(body.sortOrder) ?? undefined,
  };
}

export function parseSetCreate(body: Record<string, unknown>): CreateSetInput {
  const common = readCommon(body);
  // Spread first, then override: `common.title` may be undefined, and the
  // domain layer wants a definite string so its own validation can report a
  // readable "Title is required" error.
  return {
    ...common,
    categoryId: asString(body.categoryId) ?? "",
    title: common.title ?? "",
  };
}

export function parseSetPatch(body: Record<string, unknown>): UpdateSetInput {
  const patch: UpdateSetInput = {};
  const common = readCommon(body);

  for (const key of PATCHABLE_STRING_KEYS) {
    if (body[key] !== undefined) {
      (patch as Record<string, unknown>)[key] = common[key];
    }
  }
  if (body.description !== undefined) patch.description = common.description;
  if (body.groupLabel !== undefined) patch.groupLabel = common.groupLabel;
  if (body.timeLimitSeconds !== undefined) patch.timeLimitSeconds = common.timeLimitSeconds;
  if (body.questionLimit !== undefined) patch.questionLimit = common.questionLimit;
  if (body.passingPercent !== undefined) patch.passingPercent = common.passingPercent;
  if (body.shuffleQuestions !== undefined) patch.shuffleQuestions = common.shuffleQuestions;
  if (body.shuffleOptions !== undefined) patch.shuffleOptions = common.shuffleOptions;
  if (body.sortOrder !== undefined) patch.sortOrder = common.sortOrder;
  const status = asString(body.status);
  if (status !== undefined) patch.status = status as SetStatus;

  return patch;
}
