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
  archiveQuestion,
  getQuestionForAdmin,
  listQuestionsForAdmin,
  buildFtsMatch,
  type QuestionSummary,
  type QuestionFilters,
  type QuestionWithOptions,
  type QuestionWriteResult,
  type CreateQuestionOptions,
} from "./service";

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
