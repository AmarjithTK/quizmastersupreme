/**
 * Public surface of the questions module.
 * PLAN.md §2.4 — other modules import from here, never the raw tables.
 *
 * `createQuestion` is the funnel every write path must use (§2.9).
 */

export {
  createQuestion,
  updateQuestion,
  setQuestionStatus,
  bulkSetQuestionStatus,
  archiveQuestion,
  deleteQuestion,
  bulkDeleteQuestions,
  getQuestionForAdmin,
  listQuestionsForAdmin,
  buildFtsMatch,
  type QuestionSummary,
  type QuestionFilters,
  type QuestionWithOptions,
  type QuestionWriteResult,
  type CreateQuestionOptions,
} from "./service";

export { parseCsv, toCsv, csvCell, rowsToObjects } from "./csv";
export {
  importQuestions,
  recordToDraft,
  IMPORT_COLUMNS,
  type ImportReport,
  type ImportRowResult,
  type ImportRowStatus,
} from "./import";
export { exportQuestionsCsv } from "./export";

export {
  validateQuestion,
  type QuestionDraft,
  type QuestionOptionDraft,
  type ValidationIssue,
  type ValidationResult,
} from "./validation";

export {
  computeDedupeHashes,
  contentFingerprint,
  normalizeOptionBody,
  normalizeStem,
  slugify,
} from "./normalize";

export {
  listSetQuestions,
  attachQuestions,
  detachQuestions,
  reorderSetQuestions,
  type SetQuestionRow,
} from "./membership";
