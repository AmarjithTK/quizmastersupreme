import { describe, expect, it } from "vitest";
import { buildSourcePool, GROUNDING_DEFAULTS } from "@/modules/grounding";
import { stubProvider } from "@/modules/ai";
import { plannerFixture } from "../helpers/planner-fixture";

const settings = { ...GROUNDING_DEFAULTS, mode: "single" as const };

describe("plan-scoped admin source grounding", () => {
  it("extracts only facts attributed to the supplied public document", async () => {
    const requests: Array<{ tools?: unknown; plugins?: unknown; user: string }> = [];
    const provider = stubProvider((request) => {
      requests.push(request);
      return JSON.stringify({
        summary: "The document describes mechanisms in two coverage areas.",
        facts: [
          { segment_id: "area-one", subject: "Area one", entity_key: "entity-one", fact: "The mechanism uses a staged process.", source_url: "https://example.com/official" },
          { segment_id: "area-two", subject: "Area two", entity_key: "entity-two", fact: "This fact cites a different site and must be dropped.", source_url: "https://other.example/uncited" },
        ],
      });
    });
    let fetchCalls = 0;
    const fetchImpl = (async () => {
      fetchCalls++;
      return new Response("<main>The official mechanism uses a staged process with distinct operational checks. Its operation is documented here in detail.</main>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }) as typeof fetch;
    const result = await buildSourcePool({
      topic: "Mechanisms",
      brief: "Stay within the supplied document.",
      userSources: "https://example.com/official",
      settings,
      blueprint: plannerFixture(),
    }, { provider, model: "stub/model", estimateCostUsd: () => 0, fetchImpl });
    expect(fetchCalls).toBe(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.tools).toBeUndefined();
    expect(requests[0]?.plugins).toBeUndefined();
    expect(result.pool?.extracts).toHaveLength(1);
    expect(result.pool?.extracts[0]?.url).toBe("https://example.com/official");
    expect(result.costUsd).toBe(0);
  });

  it("will not fetch a local/private URL or treat plain notes as cited evidence", async () => {
    let fetchCalls = 0;
    let modelCalls = 0;
    const fetchImpl = (async () => { fetchCalls++; throw new Error("must not fetch"); }) as typeof fetch;
    const provider = stubProvider(() => { modelCalls++; return "{}"; });
    const result = await buildSourcePool({
      topic: "Mechanisms",
      brief: "Use only this reference.",
      userSources: "http://127.0.0.1/internal This is a long set of notes with no public citation and therefore cannot count as evidence.",
      settings,
      blueprint: plannerFixture(),
    }, { provider, model: "stub/model", estimateCostUsd: () => 0, fetchImpl });
    expect(fetchCalls).toBe(0);
    expect(modelCalls).toBe(0);
    expect(result.pool).toBeNull();
    expect(result.error).toMatch(/No verifiable supplied source URL/);
  });
});
