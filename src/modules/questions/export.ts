/**
 * CSV export for the question bank (M9).
 *
 * Reuses `listQuestionsForAdmin` for filtering rather than duplicating the
 * where-clause: an export that silently ignored a filter would be a nasty
 * surprise when the file is re-imported.
 *
 * The output columns are exactly IMPORT_COLUMNS, so an export can be edited and
 * fed straight back through the importer — that round trip is covered by tests.
 */

import { inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { questionOptions, questions } from "@/db/schema";
import type { OptionKey } from "@/db/schema";
import { toCsv } from "./csv";
import { IMPORT_COLUMNS } from "./import";
import { listQuestionsForAdmin, type QuestionFilters } from "./service";

const PAGE_SIZE = 100;
const MAX_ROWS = 5000;
const MAX_BOUND_PARAMS = 90;

export async function exportQuestionsCsv(
  filters: QuestionFilters = {},
  maxRows = MAX_ROWS,
): Promise<{ csv: string; count: number }> {
  // 1. Collect matching ids, page by page, reusing the admin filter logic.
  const ids: string[] = [];
  for (let page = 1; ids.length < maxRows; page++) {
    const result = await listQuestionsForAdmin({ ...filters, page, pageSize: PAGE_SIZE });
    if (result.rows.length === 0) break;
    ids.push(...result.rows.map((row) => row.id));
    if (result.rows.length < PAGE_SIZE) break;
  }
  const limited = ids.slice(0, maxRows);
  if (limited.length === 0) {
    return { csv: toCsv([[...IMPORT_COLUMNS]]), count: 0 };
  }

  // 2. Full rows + their options, chunked to respect the bound-param ceiling.
  const questionRows: Array<typeof questions.$inferSelect> = [];
  for (let i = 0; i < limited.length; i += MAX_BOUND_PARAMS) {
    const chunk = limited.slice(i, i + MAX_BOUND_PARAMS);
    const rows = await db().select().from(questions).where(inArray(questions.id, chunk));
    questionRows.push(...rows);
  }

  const optionRows: Array<{ questionId: string; optionKey: string; body: string; isCorrect: number }> = [];
  for (let i = 0; i < limited.length; i += MAX_BOUND_PARAMS) {
    const chunk = limited.slice(i, i + MAX_BOUND_PARAMS);
    const rows = await db()
      .select({
        questionId: questionOptions.questionId,
        optionKey: questionOptions.optionKey,
        body: questionOptions.body,
        isCorrect: questionOptions.isCorrect,
      })
      .from(questionOptions)
      .where(inArray(questionOptions.questionId, chunk))
      .orderBy(questionOptions.sortOrder);
    optionRows.push(...rows);
  }

  const optionsByQuestion = new Map<string, typeof optionRows>();
  for (const row of optionRows) {
    const list = optionsByQuestion.get(row.questionId) ?? [];
    list.push(row);
    optionsByQuestion.set(row.questionId, list);
  }

  // Preserve the id order the filter produced (newest first), not the query order.
  const byId = new Map(questionRows.map((row) => [row.id, row]));
  const ordered = limited.map((id) => byId.get(id)).filter(Boolean) as typeof questionRows;

  const body = ordered.map((question) => {
    const options = optionsByQuestion.get(question.id) ?? [];
    const correct = options.find((o) => o.isCorrect === 1)?.optionKey ?? "";
    let tags = "";
    if (question.tags) {
      try {
        tags = (JSON.parse(question.tags) as string[]).join("|");
      } catch {
        tags = question.tags;
      }
    }
    const optionBody = (key: OptionKey) =>
      options.find((o) => o.optionKey === key)?.body ?? "";

    return [
      question.stem,
      optionBody("A"),
      optionBody("B"),
      optionBody("C"),
      optionBody("D"),
      optionBody("E"),
      correct,
      question.explanation ?? "",
      question.backstory ?? "",
      question.difficulty,
      question.topic ?? "",
      tags,
      question.year ?? "",
      question.examBody ?? "",
      question.source ?? "",
      question.sourceUrl ?? "",
    ];
  });

  return { csv: toCsv([[...IMPORT_COLUMNS], ...body]), count: ordered.length };
}
