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
});

export const GenerationEnvelopeSchema = z.object({
  questions: z.array(z.unknown()).min(1).max(60),
  notes: z.string().max(1000).nullish(),
});

export type GeneratedQuestion = z.infer<typeof GeneratedQuestionSchema>;
export type GenerationEnvelope = z.infer<typeof GenerationEnvelopeSchema>;

/** Turn a Zod error into short, human-readable strings for the review UI. */
export function describeIssues(error: z.ZodError): string[] {
  return error.issues.slice(0, 8).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `${path}: ${issue.message}`;
  });
}
