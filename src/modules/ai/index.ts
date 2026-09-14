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
  getCandidate,
  reviewCandidate,
  bulkReviewCandidates,
  promoteCandidate,
  pendingReviewCount,
  promptVersionStats,
  commitJobCandidates,
  commitJobToSet,
  type CommitOutcome,
  type PromptVersionStats,
  type JobProgress,
  type CreateJobInput,
  type GenerationDeps,
  type RawStorage,
  type CandidateWithJob,
} from "./pipeline";

export { openRouterProvider, stubProvider, estimateCostUsd, LlmError, type LlmProvider, type GenerationRequest, type GenerationResponse } from "./provider";

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
