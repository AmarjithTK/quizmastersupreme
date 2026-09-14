/**
 * HTTP body → domain draft coercion for the question admin routes.
 *
 * The domain layer re-validates everything through `validateQuestion()`; this
 * only keeps `undefined` and strings-of-numbers out of the draft so that
 * validation reports real content problems rather than type noise.
 */

import type { OptionKey } from "@/db/schema";
import type { QuestionDraft, QuestionOptionDraft } from "@/modules/questions";

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return asString(value);
}

function asNumberOrNull(value: unknown): number | null | undefined {
  if (value === null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function asOptions(value: unknown): QuestionOptionDraft[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
    .map((entry) => ({
      key: String(entry.key ?? "").trim().toUpperCase() as OptionKey,
      body: typeof entry.body === "string" ? entry.body : "",
    }));
}

/** Accepts a real array or a comma-separated string ("linux, history"). */
function asTags(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value.filter((t): t is string => typeof t === "string").map((t) => t.trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  }
  return undefined;
}

export function parseQuestionCreate(body: Record<string, unknown>): QuestionDraft {
  return {
    stem: asString(body.stem) ?? "",
    options: asOptions(body.options) ?? [],
    correctOptionKey: (asString(body.correctOptionKey) ?? "").trim().toUpperCase() as OptionKey,
    explanation: asNullableString(body.explanation) ?? null,
    backstory: asNullableString(body.backstory) ?? null,
    difficulty: asString(body.difficulty) ?? "medium",
    topic: asNullableString(body.topic) ?? null,
    tags: asTags(body.tags) ?? [],
    year: asNumberOrNull(body.year) ?? null,
    examBody: asNullableString(body.examBody) ?? null,
    source: asNullableString(body.source) ?? null,
    sourceUrl: asNullableString(body.sourceUrl) ?? null,
  };
}

/** Only fields actually present in the body are applied. */
export function parseQuestionPatch(body: Record<string, unknown>): Partial<QuestionDraft> {
  const patch: Partial<QuestionDraft> = {};

  if (body.stem !== undefined) patch.stem = asString(body.stem) ?? "";
  if (body.options !== undefined) patch.options = asOptions(body.options) ?? [];
  if (body.correctOptionKey !== undefined) {
    patch.correctOptionKey = (asString(body.correctOptionKey) ?? "").trim().toUpperCase() as OptionKey;
  }
  if (body.explanation !== undefined) patch.explanation = asNullableString(body.explanation) ?? null;
  if (body.backstory !== undefined) patch.backstory = asNullableString(body.backstory) ?? null;
  if (body.difficulty !== undefined) patch.difficulty = asString(body.difficulty);
  if (body.topic !== undefined) patch.topic = asNullableString(body.topic) ?? null;
  if (body.tags !== undefined) patch.tags = asTags(body.tags) ?? [];
  if (body.year !== undefined) patch.year = asNumberOrNull(body.year) ?? null;
  if (body.examBody !== undefined) patch.examBody = asNullableString(body.examBody) ?? null;
  if (body.source !== undefined) patch.source = asNullableString(body.source) ?? null;
  if (body.sourceUrl !== undefined) patch.sourceUrl = asNullableString(body.sourceUrl) ?? null;

  return patch;
}
