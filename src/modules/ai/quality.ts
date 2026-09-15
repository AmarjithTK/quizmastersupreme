import { normalizeStem, type QuestionDraft } from "@/modules/questions";
import type { AiCandidate, AiGenerationSegment, AiSourceFact } from "@/db/schema";
import type { BatchDirective, GenerationBlueprint } from "./planner";

export type CandidateMetadata = {
  segmentId: string | null;
  entityKey: string | null;
  factKey: string | null;
  questionType: string | null;
  sourceIds: string[];
};

export type PolicyVerdict = {
  accepted: boolean;
  code: "clean" | "missing_metadata" | "unknown_segment" | "segment_not_allocated" | "segment_quota" | "question_type" | "question_type_quota" | "entity_cap" | "duplicate_fact" | "forbidden_pattern" | "scope_drift" | "missing_source";
  reason: string | null;
};

/** Explainable policy checks; semantic criticism remains an optional later layer. */
export function checkCandidatePolicy(input: {
  draft: QuestionDraft;
  metadata: CandidateMetadata;
  blueprint: GenerationBlueprint | null;
  segments: AiGenerationSegment[];
  existing: AiCandidate[];
  validSourceIds: Set<string>;
  sourceFacts?: AiSourceFact[];
  directive?: BatchDirective | null;
  currentSegmentCounts?: Map<string, number>;
  currentQuestionTypeCounts?: Map<string, number>;
  /** Policy-valid items earlier in the same model response. */
  currentEntityCounts?: Map<string, number>;
  currentFactKeys?: Set<string>;
}): PolicyVerdict {
  if (!input.blueprint) return { accepted: true, code: "clean", reason: null };
  const metadata = input.metadata;
  if (!metadata.segmentId || !metadata.entityKey || !metadata.factKey || !metadata.questionType) {
    return {
      accepted: false,
      code: "missing_metadata",
      reason: "The planned generator omitted segment/entity/fact/question-type metadata.",
    };
  }
  const segment = input.segments.find((row) => row.key === metadata.segmentId);
  const planned = input.blueprint.segments.find((row) => row.id === metadata.segmentId);
  if (!segment || !planned) {
    return { accepted: false, code: "unknown_segment", reason: `Unknown plan segment "${metadata.segmentId}".` };
  }
  if (input.directive) {
    const slot = input.directive.slots.find((entry) => entry.segmentId === metadata.segmentId);
    if (!slot) return { accepted: false, code: "segment_not_allocated", reason: `Segment ${metadata.segmentId} was not allocated to this batch.` };
    if ((input.currentSegmentCounts?.get(metadata.segmentId) ?? 0) >= slot.count) {
      return { accepted: false, code: "segment_quota", reason: `Batch slot quota exceeded for ${metadata.segmentId} (${slot.count}).` };
    }
  }
  if (!input.blueprint.globalPolicy.requiredQuestionTypes.some((entry) => entry.type === metadata.questionType)) {
    return { accepted: false, code: "question_type", reason: `Unplanned question type: ${metadata.questionType}.` };
  }
  if (input.directive && (input.currentQuestionTypeCounts?.get(metadata.questionType) ?? 0) >= (input.directive.questionTypeCounts[metadata.questionType] ?? 0)) {
    return { accepted: false, code: "question_type_quota", reason: `Batch question-type quota exceeded for ${metadata.questionType}.` };
  }

  const excludedEntity = planned.entityPolicy.excludedEntities.find(
    (entry) => normalizeStem(entry) === normalizeStem(metadata.entityKey ?? ""),
  );
  if (excludedEntity) {
    return { accepted: false, code: "scope_drift", reason: `Entity ${excludedEntity} is explicitly excluded by the approved segment.` };
  }

  const entity = normalizeStem(metadata.entityKey);
  const sameEntity = input.existing.filter(
    (candidate) => candidate.superseded === 0 && candidate.rejected === 0 && normalizeStem(candidate.entityKey ?? "") === entity,
  ).length + (input.currentEntityCounts?.get(entity) ?? 0);
  const globalCap = Math.max(1, Math.floor(input.blueprint.globalPolicy.maxEntityShare * input.blueprint.segments.reduce((sum, item) => sum + item.targetCount, 0)));
  const cap = Math.min(planned.entityPolicy.maxPerEntity, globalCap);
  if (entity && sameEntity >= cap) {
    return { accepted: false, code: "entity_cap", reason: `Entity cap reached for ${metadata.entityKey} (${cap}).` };
  }

  const fact = normalizeStem(metadata.factKey);
  if (fact && (
    input.currentFactKeys?.has(fact) ||
    input.existing.some((candidate) => candidate.superseded === 0 && normalizeStem(candidate.factKey ?? "") === fact)
  )) {
    return { accepted: false, code: "duplicate_fact", reason: "That tested fact was already generated in this job." };
  }

  const answer = input.draft.options.find((option) => option.key === input.draft.correctOptionKey)?.body ?? "";
  const testedFact = normalizeStem(`${input.draft.stem} ${answer}`);
  const combined = normalizeStem(`${input.draft.stem} ${input.draft.options.map((option) => option.body).join(" ")}`);
  for (const pattern of [...input.blueprint.globalPolicy.prohibitedPatterns, ...planned.forbiddenAngles]) {
    const normalized = normalizeStem(pattern);
    if (normalized && combined.includes(normalized)) {
      return { accepted: false, code: "forbidden_pattern", reason: `Matched prohibited pattern/angle: ${pattern}` };
    }
  }

  for (const excluded of input.blueprint.interpretation.outOfScope) {
    const normalized = normalizeStem(excluded);
    if (normalized && testedFact.includes(normalized)) {
      return { accepted: false, code: "scope_drift", reason: `The tested stem/answer matches excluded scope: ${excluded}.` };
    }
  }
  const excludesGenericBiography = [...input.blueprint.interpretation.outOfScope, ...planned.forbiddenAngles]
    .some((value) => /biograph|birth|education|awards?|personal life/i.test(value));
  if (excludesGenericBiography && /\b(where was .{1,100} born|birth ?place|birth ?date|what degree|which (college|university|school|award)|where did .{1,100} (study|graduate)|who (is|was) .{1,100} (spouse|parent)|net worth)\b/i.test(input.draft.stem)) {
    return { accepted: false, code: "scope_drift", reason: "The stem tests generic biography/personal trivia excluded by the plan, regardless of its segment tag." };
  }

  const cited = (input.sourceFacts ?? []).filter((fact) => metadata.sourceIds.includes(fact.id));
  if (metadata.sourceIds.some((id) => !input.validSourceIds.has(id))) {
    return { accepted: false, code: "missing_source", reason: "One or more cited source IDs do not exist in this job's source pack." };
  }
  if (cited.some((fact) => fact.segmentId !== segment.id)) {
    return { accepted: false, code: "missing_source", reason: "A cited source fact belongs to a different coverage segment." };
  }
  if (planned.sourceRequirements.length > 0 && cited.length === 0) {
    return { accepted: false, code: "missing_source", reason: `Segment ${planned.id} requires a citation from its assigned source pack.` };
  }

  if (input.blueprint.interpretation.freshness !== "stable") {
    const hasCurrentLanguage = /\b(current|currently|today|now|present)\b/i.test(input.draft.stem);
    if (hasCurrentLanguage && !cited.some((fact) => fact.freshness === "current")) {
      return { accepted: false, code: "missing_source", reason: "A current-fact question requires a current citation from its assigned source pack." };
    }
  }

  return { accepted: true, code: "clean", reason: null };
}
