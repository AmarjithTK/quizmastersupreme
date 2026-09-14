/**
 * Parsing the model's response into candidates (M10).
 *
 * Models wrap JSON in prose, add markdown fences, emit trailing commas, and
 * truncate mid-array when they hit a token limit. A single `JSON.parse` would
 * throw away an otherwise good batch, so this runs a REPAIR CHAIN and records
 * which step was needed.
 *
 * Questions are then validated INDIVIDUALLY: one malformed item must not
 * discard the rest, and rejected items carry their errors so an admin can see
 * exactly what the model got wrong (PLAN.md §12.5 — silent dropping is
 * forbidden).
 */

import type { QuestionDraft } from "@/modules/questions";
import {
  describeIssues,
  GeneratedQuestionSchema,
  GenerationEnvelopeSchema,
  type GeneratedQuestion,
} from "./schema";

export type ParseRepair = "none" | "fence" | "slice" | "trailing-commas" | "closed";

export type ParsedCandidate = {
  /** Position in the model's array, so a rejection can be traced back. */
  index: number;
  draft: QuestionDraft;
  raw: unknown;
};

export type RejectedCandidate = {
  index: number;
  errors: string[];
  raw: unknown;
};

export type ParseResult = {
  accepted: ParsedCandidate[];
  rejected: RejectedCandidate[];
  notes: string | null;
  repair: ParseRepair;
};

export class GenerationParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenerationParseError";
  }
}

function tryJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function stripFences(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  return fenced?.[1]?.trim() ?? text;
}

function sliceToObject(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return text;
  return text.slice(start, end + 1);
}

function removeTrailingCommas(text: string): string {
  return text.replace(/,\s*([}\]])/g, "$1");
}

/**
 * Close a response truncated mid-array.
 *
 * Appends whichever brackets are still open, and drops a trailing partial
 * member (a dangling comma, or a half-written string) so the closers land in a
 * parseable position. The last question may still be invalid — that is fine,
 * it is rejected individually and the rest of the batch survives.
 */
function closeTruncated(text: string): string {
  let candidate = text.trimEnd();

  // Drop a dangling comma or an unterminated string at the very end.
  candidate = candidate.replace(/,\s*$/, "");
  const quotes = (candidate.match(/(?<!\\)"/g) ?? []).length;
  if (quotes % 2 === 1) {
    const lastQuote = candidate.lastIndexOf('"');
    candidate = candidate.slice(0, lastQuote).replace(/,\s*$/, "");
  }

  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (const char of candidate) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{" || char === "[") stack.push(char);
    if (char === "}" || char === "]") stack.pop();
  }

  let result = candidate;
  for (let i = stack.length - 1; i >= 0; i--) {
    result += stack[i] === "{" ? "}" : "]";
  }
  return result;
}

/** Locate the questions array in whatever shape the model returned. */
function extractQuestions(parsed: unknown): { questions: unknown[]; notes: string | null } {
  if (Array.isArray(parsed)) {
    return { questions: parsed, notes: null };
  }

  const envelope = GenerationEnvelopeSchema.safeParse(parsed);
  if (envelope.success) {
    return { questions: envelope.data.questions, notes: envelope.data.notes ?? null };
  }

  // Some models key the array differently; accept a single array-valued key.
  if (parsed && typeof parsed === "object") {
    const values = Object.values(parsed as Record<string, unknown>);
    const array = values.find((value) => Array.isArray(value));
    if (Array.isArray(array)) return { questions: array, notes: null };
  }

  throw new GenerationParseError(
    "The model's response did not contain a questions array.",
  );
}

function toDraft(question: GeneratedQuestion, fallbackTopic: string): QuestionDraft {
  return {
    stem: question.stem,
    options: question.options.map((option) => ({ key: option.key, body: option.body })),
    correctOptionKey: question.correct_option_key,
    explanation: question.explanation ?? null,
    backstory: question.backstory,
    difficulty: question.difficulty,
    topic: question.topic ?? fallbackTopic,
    tags: question.tags ?? [],
    year: null,
    examBody: null,
    source: question.source ?? null,
    sourceUrl: null,
  };
}

export function parseGenerationResponse(text: string, fallbackTopic = ""): ParseResult {
  const attempts: Array<{ repair: ParseRepair; transform: (input: string) => string }> = [
    { repair: "none", transform: (input) => input.trim() },
    { repair: "fence", transform: (input) => stripFences(input) },
    { repair: "slice", transform: (input) => sliceToObject(stripFences(input)) },
    {
      repair: "trailing-commas",
      transform: (input) => removeTrailingCommas(sliceToObject(stripFences(input))),
    },
    {
      repair: "closed",
      transform: (input) => closeTruncated(removeTrailingCommas(sliceToObject(stripFences(input)))),
    },
  ];

  let parsed: unknown;
  let repair: ParseRepair = "none";
  let found = false;

  for (const attempt of attempts) {
    const candidate = tryJson(attempt.transform(text));
    if (candidate !== undefined) {
      parsed = candidate;
      repair = attempt.repair;
      found = true;
      break;
    }
  }

  if (!found) {
    throw new GenerationParseError("The model's response was not valid JSON, even after repair.");
  }

  const { questions, notes } = extractQuestions(parsed);

  const accepted: ParsedCandidate[] = [];
  const rejected: RejectedCandidate[] = [];

  for (const [index, raw] of questions.entries()) {
    const result = GeneratedQuestionSchema.safeParse(raw);
    if (result.success) {
      accepted.push({ index, draft: toDraft(result.data, fallbackTopic), raw });
    } else {
      rejected.push({ index, errors: describeIssues(result.error), raw });
    }
  }

  return { accepted, rejected, notes, repair };
}
