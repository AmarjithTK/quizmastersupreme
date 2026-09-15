import type { AiCandidate, AiGenerationSegment, AiSourceFact } from "@/db/schema";
import type { BatchDirective, GenerationBlueprint } from "./schema";

function questionTypeTargets(blueprint: GenerationBlueprint): Map<string, number> {
  const total = blueprint.segments.reduce((sum, segment) => sum + segment.targetCount, 0);
  const ideals = blueprint.globalPolicy.requiredQuestionTypes.map((entry) => entry.targetShare * total);
  const counts = ideals.map(Math.floor);
  let remainder = total - counts.reduce((sum, value) => sum + value, 0);
  const order = ideals.map((ideal, index) => ({ index, rest: ideal - Math.floor(ideal) }))
    .sort((a, b) => b.rest - a.rest || a.index - b.index);
  for (let index = 0; index < remainder; index++) {
    const at = order[index % order.length]!.index;
    counts[at] = (counts[at] ?? 0) + 1;
  }
  return new Map(blueprint.globalPolicy.requiredQuestionTypes.map((entry, index) => [entry.type, counts[index] ?? 0]));
}

function parsePolicy(segment: AiGenerationSegment): {
  allowedAngles: string[];
  forbiddenAngles: string[];
  maxPerEntity: number;
} {
  try {
    const value = JSON.parse(segment.policyJson) as {
      allowedAngles?: string[];
      forbiddenAngles?: string[];
      entityPolicy?: { maxPerEntity?: number };
    };
    return {
      allowedAngles: value.allowedAngles ?? [],
      forbiddenAngles: value.forbiddenAngles ?? [],
      maxPerEntity: value.entityPolicy?.maxPerEntity ?? 1,
    };
  } catch {
    return { allowedAngles: [], forbiddenAngles: [], maxPerEntity: 1 };
  }
}

/** Allocate the next batch across the largest normalized segment deficits. */
export function allocateBatchDirective(input: {
  blueprint: GenerationBlueprint;
  segments: AiGenerationSegment[];
  candidates: AiCandidate[];
  sourceFacts: AiSourceFact[];
  batchNo: number;
  ask: number;
  planRevision: number;
}): BatchDirective {
  const live = input.candidates.filter((candidate) => candidate.superseded === 0);
  const accepted = live.filter((candidate) => candidate.rejected === 0);
  const requiresEvidence = (segment: AiGenerationSegment) => {
    let requirements: string[] = [];
    try { requirements = JSON.parse(segment.sourceRequirementsJson) as string[]; } catch { requirements = []; }
    return input.blueprint.interpretation.freshness === "current" || requirements.length > 0;
  };
  const sourceLimitedSegmentKeys = input.segments
    .filter((segment) => segment.planRevision === input.planRevision && segment.acceptedCount < segment.targetCount)
    .filter((segment) => requiresEvidence(segment) && !input.sourceFacts.some((fact) => fact.segmentId === segment.id))
    .map((segment) => segment.key);
  const sourceLimited = new Set(sourceLimitedSegmentKeys);
  const deficits = input.segments
    .filter((segment) => segment.planRevision === input.planRevision && !sourceLimited.has(segment.key))
    .map((segment) => ({
      segment,
      remaining: Math.max(0, segment.targetCount - segment.acceptedCount),
      score:
        (Math.max(0, segment.targetCount - segment.acceptedCount) / Math.max(1, segment.targetCount)) *
        segment.priority,
    }))
    .filter((entry) => entry.remaining > 0)
    .sort((a, b) => b.score - a.score || b.remaining - a.remaining || a.segment.key.localeCompare(b.segment.key));

  const typeTargets = questionTypeTargets(input.blueprint);
  const usedTypes = new Map<string, number>();
  for (const candidate of accepted) {
    if (!candidate.questionType) continue;
    usedTypes.set(candidate.questionType, (usedTypes.get(candidate.questionType) ?? 0) + 1);
  }
  const typeDeficits = [...typeTargets].map(([type, target]) => ({
    type, remaining: Math.max(0, target - (usedTypes.get(type) ?? 0)),
  })).sort((a, b) => b.remaining - a.remaining || a.type.localeCompare(b.type));
  // The segment ledger and accepted type ledger can diverge after reviewer
  // overrides. Never ask for slots that no question type can legally fill.
  const allocatable = Math.min(
    input.ask,
    deficits.reduce((sum, entry) => sum + entry.remaining, 0),
    typeDeficits.reduce((sum, entry) => sum + entry.remaining, 0),
  );

  let remainingSlots = allocatable;
  const allocations = new Map<string, number>();
  // Round-robin over ranked deficits prevents one large segment from owning a batch.
  while (remainingSlots > 0 && deficits.some((entry) => entry.remaining > (allocations.get(entry.segment.key) ?? 0))) {
    for (const entry of deficits) {
      if (remainingSlots <= 0) break;
      const current = allocations.get(entry.segment.key) ?? 0;
      if (current >= entry.remaining) continue;
      allocations.set(entry.segment.key, current + 1);
      remainingSlots--;
    }
  }

  const slots = deficits
    .filter((entry) => (allocations.get(entry.segment.key) ?? 0) > 0)
    .map(({ segment }) => {
      const policy = parsePolicy(segment);
      return {
        segmentId: segment.key,
        segmentLabel: segment.label,
        intent: segment.intent,
        count: allocations.get(segment.key)!,
        allowedAngles: policy.allowedAngles,
        forbiddenAngles: policy.forbiddenAngles,
        maxPerEntity: policy.maxPerEntity,
        sourceIds: input.sourceFacts
          .filter((fact) => fact.segmentId === segment.id)
          .map((fact) => fact.id),
      };
    });

  const avoidEntityKeys = [...new Set(live.map((candidate) => candidate.entityKey).filter((value): value is string => Boolean(value)))];
  const avoidFactKeys = [...new Set(live.map((candidate) => candidate.factKey).filter((value): value is string => Boolean(value)))];

  const questionTypeCounts: Record<string, number> = {};
  let typesRemaining = allocatable - remainingSlots;
  while (typesRemaining > 0 && typeDeficits.some((entry) => entry.remaining > (questionTypeCounts[entry.type] ?? 0))) {
    for (const entry of typeDeficits) {
      if (typesRemaining <= 0) break;
      const current = questionTypeCounts[entry.type] ?? 0;
      if (current >= entry.remaining) continue;
      questionTypeCounts[entry.type] = current + 1;
      typesRemaining--;
    }
  }

  return {
    batchNo: input.batchNo,
    ask: allocatable - remainingSlots,
    planRevision: input.planRevision,
    slots,
    questionTypeCounts,
    sourceLimitedSegmentKeys,
    typeCapacityExhausted: typeDeficits.every((entry) => entry.remaining === 0),
    avoidEntityKeys,
    avoidFactKeys,
    adaptationReason: typeDeficits.every((entry) => entry.remaining === 0)
      ? "The approved question-type quotas have no remaining capacity."
      : sourceLimitedSegmentKeys.length > 0
      ? `Evidence is missing for ${sourceLimitedSegmentKeys.join(", ")}; allocated only source-ready deficits.`
      : slots.length > 0
        ? "Allocated across the largest remaining normalized segment deficits."
        : "No plan or question-type capacity remains.",
  };
}
