/**
 * The structured-output contract for question generation (M10).
 *
 * Zod is the single source of truth: the prompt documents this shape, the
 * parser enforces it, and TypeScript derives from it. Anything the model
 * returns that does not match becomes a REJECTED candidate with readable
 * errors — never a silent drop.
 *
 * Note the envelope holds `unknown[]`: questions are validated ONE AT A TIME so
 * a single malformed item cannot discard an otherwise good batch.
 */

import { z } from "zod";

export const GENERATED_OPTION_KEYS = ["A", "B", "C", "D", "E"] as const;
export const GENERATED_DIFFICULTIES = ["easy", "medium", "hard", "expert"] as const;

export const GeneratedOptionSchema = z.object({
  key: z.enum(GENERATED_OPTION_KEYS),
  body: z.string().min(1).max(500),
});

export const GeneratedQuestionSchema = z.object({
  stem: z.string().min(10).max(1000),
  options: z.array(GeneratedOptionSchema).min(4).max(5),
  correct_option_key: z.enum(GENERATED_OPTION_KEYS),
  explanation: z.string().max(600).nullish(),
  backstory: z.string().min(80).max(6000),
  difficulty: z.enum(GENERATED_DIFFICULTIES),
  topic: z.string().max(120).nullish(),
  tags: z.array(z.string().max(40)).max(8).nullish(),
  source: z.string().max(300).nullish(),
  /** Planner metadata. Optional only for legacy/unplanned jobs and old fixtures. */
  segment_id: z.string().max(60).nullish(),
  entity_key: z.string().max(120).nullish(),
  fact_key: z.string().max(180).nullish(),
  question_type: z.string().max(80).nullish(),
  source_ids: z.array(z.string().max(80)).max(12).nullish(),
});

export const GenerationEnvelopeSchema = z.object({
  questions: z.array(z.unknown()).min(1).max(60),
  notes: z.string().max(1000).nullish(),
});

export type GeneratedQuestion = z.infer<typeof GeneratedQuestionSchema>;
export type GenerationEnvelope = z.infer<typeof GenerationEnvelopeSchema>;

/** Provider-side contract. Exact item count prevents a nominal 25-item call returning 1. */
export function generationResponseJsonSchema(count: number, planned: boolean): Record<string, unknown> {
  const questionProperties: Record<string, unknown> = {
    stem: { type: "string", minLength: 10, maxLength: 1000 },
    options: {
      type: "array",
      minItems: 4,
      maxItems: 4,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "body"],
        properties: {
          key: { type: "string", enum: ["A", "B", "C", "D"] },
          body: { type: "string", minLength: 1, maxLength: 500 },
        },
      },
    },
    correct_option_key: { type: "string", enum: ["A", "B", "C", "D"] },
    explanation: { type: ["string", "null"], maxLength: 600 },
    backstory: { type: "string", minLength: 80, maxLength: 6000 },
    difficulty: { type: "string", enum: [...GENERATED_DIFFICULTIES] },
    topic: { type: ["string", "null"], maxLength: 120 },
    tags: { type: "array", maxItems: 8, items: { type: "string", maxLength: 40 } },
    source: { type: ["string", "null"], maxLength: 300 },
  };
  const required = [
    "stem", "options", "correct_option_key", "explanation", "backstory",
    "difficulty", "topic", "tags", "source",
  ];
  if (planned) {
    Object.assign(questionProperties, {
      segment_id: { type: "string", minLength: 1, maxLength: 60 },
      entity_key: { type: "string", minLength: 1, maxLength: 120 },
      fact_key: { type: "string", minLength: 1, maxLength: 180 },
      question_type: { type: "string", minLength: 1, maxLength: 80 },
      source_ids: { type: "array", maxItems: 12, items: { type: "string", maxLength: 80 } },
    });
    required.push("segment_id", "entity_key", "fact_key", "question_type", "source_ids");
  }
  return {
    type: "object",
    additionalProperties: false,
    required: ["questions"],
    properties: {
      questions: {
        type: "array",
        minItems: count,
        maxItems: count,
        items: {
          type: "object",
          additionalProperties: false,
          required,
          properties: questionProperties,
        },
      },
    },
  };
}

/** Turn a Zod error into short, human-readable strings for the review UI. */
export function describeIssues(error: z.ZodError): string[] {
  return error.issues.slice(0, 8).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `${path}: ${issue.message}`;
  });
}
