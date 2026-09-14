/**
 * Question validation — the `validateQuestion()` funnel named in PLAN.md §2.9.
 *
 * EVERY question write goes through here: manual authoring, CSV import, and
 * (from M10) promotion of an approved AI candidate. There is no trusted path
 * that skips it.
 *
 * Errors BLOCK a write. Warnings do not — they are surfaced to the author so a
 * human decides. That split matters: auto-rejecting a question for a stylistic
 * smell would throw away good content, while auto-accepting an ambiguous one
 * would corrupt the bank.
 */

import { normalizeStem } from "./normalize";
import { OPTION_KEYS, type OptionKey } from "@/db/schema";

export type QuestionOptionDraft = {
  key: OptionKey;
  body: string;
};

export type QuestionDraft = {
  stem: string;
  options: QuestionOptionDraft[];
  correctOptionKey: OptionKey;
  explanation?: string | null;
  backstory?: string | null;
  difficulty?: string;
  topic?: string | null;
  tags?: string[];
  year?: number | null;
  examBody?: string | null;
  source?: string | null;
  sourceUrl?: string | null;
};

export type ValidationIssue = {
  field: string;
  message: string;
};

export type ValidationResult = {
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  language: string;
};

const MIN_STEM = 10;
const MAX_STEM = 1000;
const MIN_OPTION = 1;
const MAX_OPTION = 500;
const MIN_BACKSTORY = 80;
const MAX_BACKSTORY = 6000;
const MAX_EXPLANATION = 600;
const MAX_TAGS = 8;
const MAX_TAG_LENGTH = 40;

/** Placeholder text that means someone left the template half-filled. */
const PLACEHOLDER_PATTERN =
  /lorem ipsum|\bTODO\b|\bTBD\b|\[insert[^\]]*\]|<insert|placeholder text|option [a-e]\b|answer goes here|xxx+/i;

const MIN_TAG_YEAR = 1900;

/**
 * Very small script detector. Full language detection is out of scope; this
 * only needs to distinguish "Latin script" from the Indic scripts we may be
 * asked to support (PLAN.md §24 D-7), and it is recorded rather than acted on.
 */
function detectLanguage(text: string): string {
  if (/[\u0D00-\u0D7F]/.test(text)) return "ml"; // Malayalam
  if (/[\u0900-\u097F]/.test(text)) return "hi"; // Devanagari
  if (/[\u0B80-\u0BFF]/.test(text)) return "ta"; // Tamil
  if (/[\u0C00-\u0C7F]/.test(text)) return "te"; // Telugu
  if (/[\u0C80-\u0CFF]/.test(text)) return "kn"; // Kannada
  return "en";
}

/** Loose overlap check used to ask "is the backstory just the explanation again?" */
function isRestatement(a: string, b: string): boolean {
  const na = normalizeStem(a);
  const nb = normalizeStem(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const shorter = na.length <= nb.length ? na : nb;
  const longer = na.length <= nb.length ? nb : na;
  return longer.includes(shorter) && shorter.length > 40;
}

export function validateQuestion(draft: QuestionDraft): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  const stem = draft.stem?.trim() ?? "";

  // ── Stem ───────────────────────────────────────────────────────────────
  if (!stem) {
    errors.push({ field: "stem", message: "Question text is required." });
  } else if (stem.length < MIN_STEM) {
    errors.push({
      field: "stem",
      message: `Question text must be at least ${MIN_STEM} characters.`,
    });
  } else if (stem.length > MAX_STEM) {
    errors.push({
      field: "stem",
      message: `Question text must be ${MAX_STEM} characters or fewer.`,
    });
  }
  if (PLACEHOLDER_PATTERN.test(stem)) {
    errors.push({ field: "stem", message: "Question text looks like placeholder text." });
  }

  // ── Options ────────────────────────────────────────────────────────────
  const options = draft.options ?? [];
  if (options.length < 4 || options.length > 5) {
    errors.push({
      field: "options",
      message: `A question needs 4 options (or 5 if you use E); got ${options.length}.`,
    });
  }

  const seenKeys = new Set<string>();
  for (const [index, option] of options.entries()) {
    const label = `options.${index}`;
    if (!(OPTION_KEYS as readonly string[]).includes(option.key)) {
      errors.push({ field: label, message: `"${option.key}" is not a valid option key.` });
      continue;
    }
    if (seenKeys.has(option.key)) {
      errors.push({ field: label, message: `Option ${option.key} is defined more than once.` });
    }
    seenKeys.add(option.key);

    const body = option.body?.trim() ?? "";
    if (body.length < MIN_OPTION) {
      errors.push({ field: label, message: `Option ${option.key} cannot be empty.` });
    } else if (body.length > MAX_OPTION) {
      errors.push({
        field: label,
        message: `Option ${option.key} must be ${MAX_OPTION} characters or fewer.`,
      });
    }
    if (PLACEHOLDER_PATTERN.test(body)) {
      errors.push({ field: label, message: `Option ${option.key} looks like placeholder text.` });
    }
  }

  // ── Correct option ─────────────────────────────────────────────────────
  const correctKey = draft.correctOptionKey;
  const correctOption = options.find((o) => o.key === correctKey);
  if (!correctOption) {
    errors.push({
      field: "correctOptionKey",
      message: "The correct option must be one of the options you provided.",
    });
  }

  // ── Distinct options ───────────────────────────────────────────────────
  const normalizedBodies = options.map((o) => normalizeStem(o.body ?? ""));
  const duplicates = normalizedBodies.filter(
    (body, index) => body.length > 0 && normalizedBodies.indexOf(body) !== index,
  );
  if (duplicates.length > 0) {
    errors.push({
      field: "options",
      message: "Two options have identical text. Options must be distinct.",
    });
  }

  // ── Stem giveaway ──────────────────────────────────────────────────────
  if (correctOption) {
    const normalizedBody = normalizeStem(correctOption.body ?? "");
    // Only meaningful for options with real content; "1" or "N/A" would match
    // almost any stem by accident.
    if (normalizedBody.length >= 4 && normalizeStem(stem).includes(normalizedBody)) {
      errors.push({
        field: "stem",
        message: "The question text contains the correct answer verbatim.",
      });
    }
    if (/^(all|none) of the above$/i.test(correctOption.body.trim())) {
      warnings.push({
        field: "options",
        message:
          "\"All/None of the above\" as the correct answer is easy to get wrong. Double-check the other options are all true (or all false).",
      });
    }
  }

  // ── Explanation & backstory ────────────────────────────────────────────
  const explanation = draft.explanation?.trim() ?? "";
  const backstory = draft.backstory?.trim() ?? "";

  if (explanation.length > MAX_EXPLANATION) {
    errors.push({
      field: "explanation",
      message: `The short explanation must be ${MAX_EXPLANATION} characters or fewer.`,
    });
  }
  if (backstory) {
    if (backstory.length < MIN_BACKSTORY) {
      errors.push({
        field: "backstory",
        message: `A backstory must be at least ${MIN_BACKSTORY} characters — it is the part learners actually read.`,
      });
    } else if (backstory.length > MAX_BACKSTORY) {
      errors.push({
        field: "backstory",
        message: `The backstory must be ${MAX_BACKSTORY} characters or fewer.`,
      });
    }
    if (PLACEHOLDER_PATTERN.test(backstory)) {
      errors.push({ field: "backstory", message: "The backstory looks like placeholder text." });
    }
    if (explanation && isRestatement(backstory, explanation)) {
      warnings.push({
        field: "backstory",
        message: "The backstory repeats the short explanation. Add real context instead.",
      });
    }
  } else {
    warnings.push({
      field: "backstory",
      message: "No backstory yet. Questions without one are much less useful to revise from.",
    });
  }

  // ── Tags, year, sources ────────────────────────────────────────────────
  const tags = draft.tags ?? [];
  if (tags.length > MAX_TAGS) {
    errors.push({ field: "tags", message: `Use at most ${MAX_TAGS} tags.` });
  }
  for (const tag of tags) {
    if (tag.length > MAX_TAG_LENGTH) {
      errors.push({
        field: "tags",
        message: `Each tag must be ${MAX_TAG_LENGTH} characters or fewer ("${tag.slice(0, 20)}…").`,
      });
      break;
    }
  }

  if (draft.year != null) {
    const maxYear = new Date().getUTCFullYear() + 1;
    if (!Number.isInteger(draft.year) || draft.year < MIN_TAG_YEAR || draft.year > maxYear) {
      errors.push({
        field: "year",
        message: `Year must be between ${MIN_TAG_YEAR} and ${maxYear}.`,
      });
    }
  }

  if (draft.sourceUrl) {
    try {
      const url = new URL(draft.sourceUrl);
      if (!["http:", "https:"].includes(url.protocol)) {
        errors.push({ field: "sourceUrl", message: "Source links must be http or https." });
      }
    } catch {
      errors.push({ field: "sourceUrl", message: "That source link is not a valid URL." });
    }
  }

  return { errors, warnings, language: detectLanguage(stem) };
}
