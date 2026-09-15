import { describe, expect, it } from "vitest";
import type { AiCandidate, AiGenerationSegment, AiSourceFact } from "@/db/schema";
import { canonicalizeBlueprint } from "@/modules/ai";
import { allocateBatchDirective } from "@/modules/ai/planner/allocator";
import { checkCandidatePolicy } from "@/modules/ai/quality";
import { reconcileFunnel } from "@/modules/ai/reconciliation";
import type { QuestionDraft } from "@/modules/questions";
import { plannerFixture } from "../helpers/planner-fixture";

describe("generation planner contracts", () => {
  it("normalizes model quotas to the exact requested target", () => {
    const fixture = plannerFixture();
    fixture.segments[0]!.targetCount = 7;
    fixture.segments[1]!.targetCount = 3;
    const canonical = canonicalizeBlueprint(fixture, 200, "2026-09-15");
    expect(canonical.segments.map((segment) => segment.targetCount)).toEqual([140, 60]);
    expect(canonical.segments.reduce((sum, segment) => sum + segment.targetCount, 0)).toBe(200);
  });

  it("refuses a funnel that loses any raw item", () => {
    expect(() => reconcileFunnel({
      askedCount: 5, rawItemCount: 5, schemaValidCount: 4, schemaInvalidCount: 0,
      contentValidCount: 4, contentInvalidCount: 0,
      policyValidCount: 4, policyRejectedCount: 0,
      duplicateFlaggedCount: 0, acceptedCount: 4,
    })).toThrow("raw != schema-valid + schema-invalid");
  });

  it("rejects segment IDs that collide after normalization", () => {
    const fixture = plannerFixture();
    fixture.segments[0]!.id = "Area One";
    fixture.segments[1]!.id = "area-one";
    expect(() => canonicalizeBlueprint(fixture, 10, "2026-09-15"))
      .toThrow("duplicate segment IDs");
  });

  it("allocates exact segment and question-type slots over varied deficits", () => {
    for (let target = 2; target <= 100; target++) {
      const fixture = plannerFixture();
      fixture.globalPolicy.requiredQuestionTypes = [
        { type: "mechanism", targetShare: 0.4 },
        { type: "application", targetShare: 0.6 },
      ];
      const blueprint = canonicalizeBlueprint(fixture, target, "2026-09-15");
      const segments = blueprint.segments.map((segment, index) => ({
        id: `db-${index}`, key: segment.id, planRevision: 1,
        targetCount: segment.targetCount,
        acceptedCount: Math.min(segment.targetCount, index === 0 ? Math.floor(target / 5) : Math.floor(target / 7)),
        priority: segment.priority, label: segment.label, intent: segment.intent,
        policyJson: JSON.stringify(segment), sourceRequirementsJson: "[]",
      })) as AiGenerationSegment[];
      const directive = allocateBatchDirective({
        blueprint, segments, candidates: [], sourceFacts: [],
        batchNo: 1, ask: Math.min(25, target), planRevision: 1,
      });
      expect(directive.ask).toBe(directive.slots.reduce((sum, slot) => sum + slot.count, 0));
      expect(directive.ask).toBe(Object.values(directive.questionTypeCounts).reduce((sum, count) => sum + count, 0));
      expect(directive.ask).toBeLessThanOrEqual(Math.min(25, target));
      for (const slot of directive.slots) {
        const segment = segments.find((entry) => entry.key === slot.segmentId)!;
        expect(slot.count).toBeLessThanOrEqual(segment.targetCount - segment.acceptedCount);
      }
    }
  });

  it("stops allocation when type quotas are exhausted despite stale segment ledgers", () => {
    const blueprint = canonicalizeBlueprint(plannerFixture(), 2, "2026-09-15");
    const segments = blueprint.segments.map((segment, index) => ({
      id: `db-${index}`, key: segment.id, planRevision: 1,
      targetCount: segment.targetCount, acceptedCount: 0,
      priority: 1, label: segment.label, intent: segment.intent,
      policyJson: JSON.stringify(segment), sourceRequirementsJson: "[]",
    })) as AiGenerationSegment[];
    const candidates = [0, 1].map(() => ({ superseded: 0, rejected: 0, questionType: "mechanism" })) as AiCandidate[];
    const directive = allocateBatchDirective({ blueprint, segments, candidates, sourceFacts: [], batchNo: 1, ask: 2, planRevision: 1 });
    expect(directive.ask).toBe(0);
    expect(directive.typeCapacityExhausted).toBe(true);
  });

  it("requires an assigned citation when a segment has source requirements", () => {
    const blueprint = canonicalizeBlueprint(plannerFixture(), 10, "2026-09-15");
    blueprint.segments[0]!.sourceRequirements = ["Official mechanism reference"];
    const segment = { id: "db-area-one", key: "area-one" } as AiGenerationSegment;
    const fact = { id: "fact-one", segmentId: segment.id } as AiSourceFact;
    const draft: QuestionDraft = {
      stem: "Which area-one mechanism applies to this example?",
      options: [
        { key: "A", body: "Mechanism A" }, { key: "B", body: "Mechanism B" },
        { key: "C", body: "Mechanism C" }, { key: "D", body: "Mechanism D" },
      ],
      correctOptionKey: "A", explanation: "Mechanism A applies.",
      backstory: "An independently checkable example demonstrates the mechanism in a real context and distinguishes the plausible alternatives.",
      difficulty: "medium", topic: "area-one", tags: [],
    };
    const base = {
      draft, blueprint, segments: [segment], existing: [],
      validSourceIds: new Set([fact.id]), sourceFacts: [fact],
      metadata: { segmentId: "area-one", entityKey: "entity-a", factKey: "fact-a", questionType: "mechanism", sourceIds: [] as string[] },
    };
    expect(checkCandidatePolicy(base).code).toBe("missing_source");
    expect(checkCandidatePolicy({ ...base, metadata: { ...base.metadata, sourceIds: [fact.id] } }).accepted).toBe(true);
  });
});
