import { GenerationBlueprintSchema, type GenerationBlueprint } from "@/modules/ai";

export function plannerFixture(): GenerationBlueprint {
  return GenerationBlueprintSchema.parse({
    version: "v1",
    title: "Balanced mechanism questions",
    interpretation: {
      objective: "Test distinct mechanisms across two coverage areas, without biography or unrelated trivia.",
      audience: "exam learners",
      inScope: ["Area one", "Area two"],
      outOfScope: ["biography"],
      assumptions: [],
      ambiguityWarnings: [],
      freshness: "stable",
      asOfDate: "2026-09-15",
    },
    segments: ["area-one", "area-two"].map((id) => ({
      id,
      label: id,
      intent: `Test the practical mechanism of ${id} through distinct checkable facts.`,
      targetCount: 5,
      priority: 1,
      allowedAngles: ["mechanism"],
      forbiddenAngles: ["birthplace"],
      entityPolicy: { maxPerEntity: 2, preferredEntityClasses: [], excludedEntities: [] },
      sourceQueries: [`${id} official mechanism`],
      sourceRequirements: [],
    })),
    globalPolicy: {
      maxEntityShare: 0.5,
      maxConsecutiveSameEntity: 2,
      requiredQuestionTypes: [{ type: "mechanism", targetShare: 1 }],
      prohibitedPatterns: ["all of the above"],
      language: "English",
    },
  });
}
