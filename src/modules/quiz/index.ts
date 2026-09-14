/**
 * Public surface of the quiz module.
 * PLAN.md §2.4 — other modules import from here, never the raw tables.
 */

export {
  startOrResumeAttempt,
  getAttemptState,
  getAttemptQuestions,
  getAttemptQuestion,
  submitAnswer,
  getAnswerReveal,
  completeAttempt,
  abandonAttempt,
  getAttemptSummary,
  SUBMISSION_GRACE_MS,
  MAX_QUESTION_MS,
  type AttemptQuestion,
  type AnswerResult,
  type AttemptState,
  type AttemptSummary,
} from "./engine";

export { computeScore, shuffleWithCrypto, randomInt, type Score } from "./scoring";

export { assertTransition, canTransition, isTerminal, isWritable } from "./state-machine";
