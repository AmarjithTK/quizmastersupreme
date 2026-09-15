import { z } from "zod";
import { validationError } from "@/lib/errors";

const StringList = z.array(z.string().min(1).max(240)).max(40);

export const BlueprintWarningSchema = z.object({
  code: z.string().min(1).max(60),
  message: z.string().min(1).max(600),
  blocking: z.boolean(),
}).strict();

export const BlueprintSegmentSchema = z.object({
  id: z.string().min(1).max(60),
  label: z.string().min(1).max(120),
  intent: z.string().min(10).max(800),
  targetCount: z.number().int().min(1).max(1000),
  priority: z.number().int().min(1).max(10),
  allowedAngles: StringList.min(1),
  forbiddenAngles: StringList,
  entityPolicy: z.object({
    maxPerEntity: z.number().int().min(1).max(1000),
    preferredEntityClasses: StringList,
    excludedEntities: StringList,
  }).strict(),
  sourceQueries: StringList,
  sourceRequirements: StringList,
}).strict();

export const GenerationBlueprintSchema = z.object({
  version: z.string().min(1).max(40),
  title: z.string().min(1).max(160),
  interpretation: z.object({
    objective: z.string().min(10).max(1200),
    audience: z.string().max(240).nullable(),
    inScope: StringList.min(1),
    outOfScope: StringList,
    assumptions: StringList,
    ambiguityWarnings: z.array(BlueprintWarningSchema).max(12),
    freshness: z.enum(["stable", "current", "mixed"]),
    asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }).strict(),
  segments: z.array(BlueprintSegmentSchema).min(1).max(20),
  globalPolicy: z.object({
    maxEntityShare: z.number().min(0.01).max(1),
    maxConsecutiveSameEntity: z.number().int().min(1).max(10),
    requiredQuestionTypes: z.array(z.object({
      type: z.string().min(1).max(80),
      targetShare: z.number().min(0).max(1),
    }).strict()).min(1).max(16),
    prohibitedPatterns: StringList,
    language: z.string().min(2).max(40),
  }).strict(),
}).strict();

export type GenerationBlueprint = z.infer<typeof GenerationBlueprintSchema>;
export type BlueprintSegment = z.infer<typeof BlueprintSegmentSchema>;

export type BatchDirective = {
  batchNo: number;
  ask: number;
  planRevision: number;
  slots: Array<{
    segmentId: string;
    segmentLabel: string;
    intent: string;
    count: number;
    allowedAngles: string[];
    forbiddenAngles: string[];
    maxPerEntity: number;
    sourceIds: string[];
  }>;
  /** Exact question-type quotas for this response, derived from job-wide deficits. */
  questionTypeCounts: Record<string, number>;
  sourceLimitedSegmentKeys: string[];
  typeCapacityExhausted: boolean;
  avoidEntityKeys: string[];
  avoidFactKeys: string[];
  adaptationReason: string;
};

export const GENERATION_BLUEPRINT_JSON_SCHEMA = z.toJSONSchema(GenerationBlueprintSchema, {
  target: "draft-07",
}) as Record<string, unknown>;

function cleanList(values: string[], max = 40): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(0, max);
}

function slug(value: string, fallback: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return normalized || fallback;
}

/**
 * Models are poor accountants. Normalize names/lists and use largest-remainder
 * allocation so the persisted segment quotas always equal the requested target.
 */
export function canonicalizeBlueprint(
  input: GenerationBlueprint,
  requestedCount: number,
  asOfDate: string,
): GenerationBlueprint {
  const parsed = GenerationBlueprintSchema.parse(input);
  const target = Math.max(1, Math.trunc(requestedCount));
  const originalIds = parsed.segments.map((segment, index) => slug(segment.id, `segment-${index + 1}`));
  if (new Set(originalIds).size !== originalIds.length) {
    throw validationError("Generation blueprint contains duplicate segment IDs after normalization.");
  }
  const rawTotal = parsed.segments.reduce((sum, segment) => sum + segment.targetCount, 0);
  const ideals = parsed.segments.map((segment) => (segment.targetCount / Math.max(1, rawTotal)) * target);
  const allocated = ideals.map(Math.floor);
  let left = target - allocated.reduce((sum, count) => sum + count, 0);
  const order = ideals
    .map((ideal, index) => ({ index, remainder: ideal - Math.floor(ideal) }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (let i = 0; i < left; i++) {
    const index = order[i % order.length]!.index;
    allocated[index] = (allocated[index] ?? 0) + 1;
  }

  const segments = parsed.segments
    .map((segment, index) => {
      const count = allocated[index]!;
      if (count <= 0) return null;
      const id = originalIds[index]!;
      return {
        ...segment,
        id,
        label: segment.label.trim(),
        intent: segment.intent.trim(),
        targetCount: count,
        priority: Math.min(10, Math.max(1, segment.priority)),
        allowedAngles: cleanList(segment.allowedAngles),
        forbiddenAngles: cleanList(segment.forbiddenAngles),
        entityPolicy: {
          maxPerEntity: Math.min(count, Math.max(1, segment.entityPolicy.maxPerEntity)),
          preferredEntityClasses: cleanList(segment.entityPolicy.preferredEntityClasses),
          excludedEntities: cleanList(segment.entityPolicy.excludedEntities),
        },
        sourceQueries: cleanList(segment.sourceQueries, 12),
        sourceRequirements: cleanList(segment.sourceRequirements, 12),
      };
    })
    .filter((segment): segment is NonNullable<typeof segment> => segment !== null);

  const types = parsed.globalPolicy.requiredQuestionTypes;
  const shareTotal = types.reduce((sum, entry) => sum + entry.targetShare, 0);
  const requiredQuestionTypes = types.map((entry) => ({
    type: entry.type.trim(),
    targetShare: shareTotal > 0 ? entry.targetShare / shareTotal : 1 / types.length,
  }));

  return GenerationBlueprintSchema.parse({
    ...parsed,
    version: parsed.version.trim(),
    title: parsed.title.trim(),
    interpretation: {
      ...parsed.interpretation,
      objective: parsed.interpretation.objective.trim(),
      audience: parsed.interpretation.audience?.trim() || null,
      inScope: cleanList(parsed.interpretation.inScope),
      outOfScope: cleanList(parsed.interpretation.outOfScope),
      assumptions: cleanList(parsed.interpretation.assumptions),
      ambiguityWarnings: parsed.interpretation.ambiguityWarnings.map((warning) => ({
        ...warning,
        code: slug(warning.code, "ambiguity").replace(/-/g, "_").toUpperCase(),
        message: warning.message.trim(),
      })),
      asOfDate,
    },
    segments,
    globalPolicy: {
      ...parsed.globalPolicy,
      maxEntityShare: Math.min(1, Math.max(0.01, parsed.globalPolicy.maxEntityShare)),
      maxConsecutiveSameEntity: Math.min(10, Math.max(1, parsed.globalPolicy.maxConsecutiveSameEntity)),
      requiredQuestionTypes,
      prohibitedPatterns: cleanList(parsed.globalPolicy.prohibitedPatterns),
      language: parsed.globalPolicy.language.trim(),
    },
  });
}
