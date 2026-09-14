/**
 * Bulk CSV import for the question bank (M9).
 *
 * PLAN.md §2.9 requires every write path to run the same validation and
 * duplicate detection as manual authoring. This importer honours that — it
 * calls the SAME `validateQuestion()` and the SAME layer-1 hash comparison —
 * but batches the I/O. Calling `createQuestion()` per row would mean ~3 D1
 * round trips per question, so a 500-row file would be ~1,500 round trips and
 * would blow the Worker's CPU budget.
 *
 * Nothing is ever dropped silently: every input row comes back in the report
 * with a status, and every rejection carries its reasons.
 */

import { inArray } from "drizzle-orm";
import { db } from "@/db/client";
import {
  newId,
  nowMs,
  questionOptions,
  questions,
  type OptionKey,
  type QuestionStatus,
} from "@/db/schema";
import { recordAudit } from "@/modules/audit";
import { checkCandidates, type SemanticDedupe } from "@/modules/dedupe";
import { simhashHex } from "@/modules/dedupe/simhash";
import { parseCsv, rowsToObjects } from "./csv";
import { computeDedupeHashes } from "./normalize";
import { validateQuestion, type QuestionDraft } from "./validation";

/** Conservative bound-parameter budget (PLAN.md §6.5). */
const MAX_BOUND_PARAMS = 90;

export const IMPORT_COLUMNS = [
  "stem",
  "option_a",
  "option_b",
  "option_c",
  "option_d",
  "option_e",
  "correct",
  "explanation",
  "backstory",
  "difficulty",
  "topic",
  "tags",
  "year",
  "exam_body",
  "source",
  "source_url",
] as const;

export type ImportRowStatus = "created" | "duplicate" | "duplicate_in_file" | "invalid";

export type ImportRowResult = {
  /** 1-based CSV data row (header excluded), so it matches what a human sees. */
  row: number;
  status: ImportRowStatus;
  stem: string;
  questionId?: string;
  matchedStem?: string;
  reasons?: string[];
};

export type ImportReport = {
  total: number;
  created: number;
  duplicates: number;
  invalid: number;
  dryRun: boolean;
  results: ImportRowResult[];
};

const OPTION_KEYS: OptionKey[] = ["A", "B", "C", "D", "E"];

/** CSV record → a question draft. Missing/invalid values become validation errors. */
export function recordToDraft(record: Record<string, string>): QuestionDraft {
  const options = OPTION_KEYS.map((key) => ({
    key,
    body: record[`option_${key.toLowerCase()}`] ?? "",
  })).filter((option) => option.body.trim() !== "");

  const tagsRaw = record.tags ?? "";
  const tags = tagsRaw
    .split(/[|,]/)
    .map((t) => t.trim())
    .filter(Boolean);

  const yearRaw = (record.year ?? "").trim();
  const year = yearRaw === "" ? null : Number(yearRaw);

  return {
    stem: record.stem ?? "",
    options,
    correctOptionKey: (record.correct ?? "").trim().toUpperCase() as OptionKey,
    explanation: record.explanation || null,
    backstory: record.backstory || null,
    difficulty: record.difficulty || "medium",
    topic: record.topic || null,
    tags,
    year: Number.isFinite(year) ? year : null,
    examBody: record.exam_body || null,
    source: record.source || null,
    sourceUrl: record.source_url || null,
  };
}

async function chunked<T>(
  items: T[],
  perChunk: number,
  run: (chunk: T[]) => Promise<unknown>,
): Promise<void> {
  for (let i = 0; i < items.length; i += perChunk) {
    await run(items.slice(i, i + perChunk));
  }
}

export async function importQuestions(
  csvText: string,
  actorId: string,
  options: { status?: QuestionStatus; dryRun?: boolean; semantic?: SemanticDedupe | null } = {},
): Promise<ImportReport> {
  const status = options.status ?? "draft";
  const dryRun = options.dryRun ?? false;

  const { records } = rowsToObjects(parseCsv(csvText));
  const results: ImportRowResult[] = [];

  // ── 1. Validate every row, in memory ─────────────────────────────────────
  type Candidate = {
    result: ImportRowResult;
    draft: QuestionDraft;
    language: string;
    hashes?: { normalizedHash: string; contentHash: string };
  };

  const candidates: Candidate[] = [];

  for (const [index, record] of records.entries()) {
    const rowNumber = index + 1;
    const draft = recordToDraft(record);
    const { errors, language } = validateQuestion(draft);

    if (errors.length > 0) {
      results.push({
        row: rowNumber,
        status: "invalid",
        stem: draft.stem,
        reasons: errors.map((e) => `${e.field}: ${e.message}`),
      });
      continue;
    }

    const candidate: Candidate = {
      result: { row: rowNumber, status: "created", stem: draft.stem },
      draft,
      language,
    };
    candidates.push(candidate);
  }

  // ── 2. Hashes (the same layer-1 identity manual authoring uses) ──────────
  for (const candidate of candidates) {
    candidate.hashes = await computeDedupeHashes(
      candidate.draft.stem,
      candidate.draft.options.map((o) => o.body),
    );
  }

  // ── 3. Duplicates WITHIN the file ────────────────────────────────────────
  const seenInFile = new Map<string, number>();
  const uniqueCandidates: Candidate[] = [];

  for (const candidate of candidates) {
    const hash = candidate.hashes!.normalizedHash;
    const firstRow = seenInFile.get(hash);
    if (firstRow !== undefined) {
      candidate.result.status = "duplicate_in_file";
      candidate.result.reasons = [`Same question as row ${firstRow} of this file.`];
      results.push(candidate.result);
      continue;
    }
    seenInFile.set(hash, candidate.result.row);
    uniqueCandidates.push(candidate);
  }

  // ── 4. Duplicates against the EXISTING bank, via the shared funnel ───────
  // Layers 1-3 in one batched pass, so a CSV import gets exactly the same
  // duplicate treatment as a hand-typed question (§2.9).
  const verdicts = await checkCandidates(
    uniqueCandidates.map((candidate) => ({
      stem: candidate.draft.stem,
      optionBodies: candidate.draft.options.map((o) => o.body),
    })),
    { semantic: options.semantic },
  );

  const toInsert: Candidate[] = [];
  for (const [index, candidate] of uniqueCandidates.entries()) {
    const verdict = verdicts[index]!;
    if (verdict.autoReject || verdict.status !== "clean") {
      candidate.result.status = "duplicate";
      candidate.result.matchedStem = verdict.bestMatch?.stem || undefined;
      candidate.result.reasons = [
        verdict.autoReject
          ? `Already in the bank as ${verdict.bestMatch?.questionId ?? "an existing question"}.`
          : `Looks like an existing question (${Math.round((verdict.bestMatch?.similarity ?? 0) * 100)}% similar).`,
      ];
      results.push(candidate.result);
      continue;
    }
    toInsert.push(candidate);
  }

  // ── 5. Insert, chunked, unless this is a dry run ─────────────────────────
  const now = nowMs();
  const inserted: Array<{ candidate: Candidate; questionId: string }> = [];

  if (!dryRun && toInsert.length > 0) {
    // 25 columns on `questions`, 6 on `question_options`.
    const questionRows = toInsert.map((candidate) => {
      const questionId = newId();
      inserted.push({ candidate, questionId });
      return {
        id: questionId,
        stem: candidate.draft.stem.trim(),
        stemFormat: "markdown",
        explanation: candidate.draft.explanation?.trim() || null,
        backstory: candidate.draft.backstory?.trim() || null,
        backstoryFormat: "markdown",
        difficulty: candidate.draft.difficulty ?? "medium",
        topic: candidate.draft.topic?.trim() || null,
        tags:
          candidate.draft.tags && candidate.draft.tags.length > 0
            ? JSON.stringify(candidate.draft.tags)
            : null,
        year: candidate.draft.year ?? null,
        source: candidate.draft.source?.trim() || null,
        sourceUrl: candidate.draft.sourceUrl?.trim() || null,
        examBody: candidate.draft.examBody?.trim() || null,
        language: candidate.language,
        status,
        normalizedHash: candidate.hashes!.normalizedHash,
        contentHash: candidate.hashes!.contentHash,
        simhash: simhashHex(candidate.draft.stem),
        origin: "import" as const,
        createdBy: actorId,
        generationJobId: null,
        approvedBy: status === "published" || status === "approved" ? actorId : null,
        approvedAt: status === "published" || status === "approved" ? now : null,
        createdAt: now,
        updatedAt: now,
      };
    });

    await chunked(questionRows, Math.max(1, Math.floor(MAX_BOUND_PARAMS / 25)), (chunk) =>
      db().insert(questions).values(chunk),
    );

    const optionRows = inserted.flatMap(({ candidate, questionId }) =>
      candidate.draft.options.map((option, index) => ({
        id: `${questionId}_${option.key}`,
        questionId,
        optionKey: option.key,
        body: option.body.trim(),
        isCorrect: option.key === candidate.draft.correctOptionKey ? 1 : 0,
        sortOrder: index,
      })),
    );

    await chunked(optionRows, Math.max(1, Math.floor(MAX_BOUND_PARAMS / 6)), (chunk) =>
      db().insert(questionOptions).values(chunk),
    );

    for (const { candidate, questionId } of inserted) {
      candidate.result.questionId = questionId;
    }
  }

  // A dry run produces no `inserted` rows, but the rows that WOULD be created
  // still have to appear in the report — otherwise a dry run silently omits
  // exactly the rows the admin is asking about.
  const reported = dryRun ? toInsert.map((candidate) => ({ candidate })) : inserted;
  for (const { candidate } of reported) results.push(candidate.result);

  // ── 6. Report ────────────────────────────────────────────────────────────
  results.sort((a, b) => a.row - b.row);

  const report: ImportReport = {
    total: records.length,
    created: results.filter((r) => r.status === "created").length,
    duplicates: results.filter((r) => r.status === "duplicate" || r.status === "duplicate_in_file")
      .length,
    invalid: results.filter((r) => r.status === "invalid").length,
    dryRun,
    results,
  };

  if (!dryRun && report.created > 0) {
    await recordAudit(actorId, "question.import", "question", null, null, {
      total: report.total,
      created: report.created,
      duplicates: report.duplicates,
      invalid: report.invalid,
      status,
    });
  }

  return report;
}
