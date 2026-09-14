/**
 * Public surface of the AI module.
 *
 * The pipeline is transport-agnostic and binding-free; `adapters.ts` supplies
 * the OpenRouter provider and R2 storage at the edge.
 */

export {
  createGenerationJob,
  runGenerationStep,
  getJob,
  listJobs,
  cancelJob,
  listCandidates,
  listJobCandidates,
  listJobBatches,
  getCandidate,
  setCandidateRejected,
  commitJobToSet,
  regenerateBatch,
  MAX_REQUESTED_HARD,
  type CommitOutcome,
  type JobProgress,
  type CreateJobInput,
  type GenerationDeps,
  type RawStorage,
  type CandidateWithJob,
} from "./pipeline";

export {
  outputBudgetFor,
  modelOutputCap,
  PER_QUESTION_TOKENS,
  DEFAULT_MODEL_CAP,
  MIN_OUTPUT_TOKENS,
} from "./budget";

export { estimateCostUsd, estimateJobCostUsd, priceFor } from "@/lib/pricing";
export { openRouterProvider, stubProvider, DEFAULT_MAX_TOKENS, LlmError, type LlmProvider, type GenerationRequest, type GenerationResponse } from "./provider";

export { configuredProvider, openRouterKeyConfigured, r2RawStorage } from "./adapters";

export { parseGenerationResponse, GenerationParseError, type ParseResult, type ParseRepair } from "./parse";

export { buildSystemPrompt, buildUserPrompt, PROMPT_VERSION, type GenerationPromptInput } from "./prompts/generate";

export {
  buildCoverageDigest,
  extractConceptKey,
  estimateTokens,
  type CoverageDigest,
  type CoverageInput,
} from "./coverage";

export {
  GeneratedQuestionSchema,
  GenerationEnvelopeSchema,
  describeIssues,
  type GeneratedQuestion,
} from "./schema";
