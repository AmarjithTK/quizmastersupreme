/**
 * Parsing model responses (M10).
 *
 * Real models wrap JSON in prose, add fences, leave trailing commas, and get
 * truncated at the token limit. Each of those is a fixture here, because the
 * difference between "handled" and "the whole batch is thrown away" is exactly
 * this chain.
 */

import { describe, expect, it } from "vitest";
import { GenerationParseError, parseGenerationResponse } from "@/modules/ai";

const BACKSTORY =
  "This is a sufficiently long backstory used by the parser tests, written as real prose so " +
  "that the schema's minimum length is satisfied without any special casing.";

const goodQuestion = (stem: string) => ({
  stem,
  options: [
    { key: "A", body: "Zephyr" },
    { key: "B", body: "Quartz" },
    { key: "C", body: "Nimbus" },
    { key: "D", body: "Onyx" },
  ],
  correct_option_key: "A",
  explanation: "Because Zephyr.",
  backstory: BACKSTORY,
  difficulty: "easy",
  topic: "ParserTest",
  tags: ["parser"],
});

const envelope = (...questions: unknown[]) => JSON.stringify({ questions });

describe("parseGenerationResponse — repair chain", () => {
  it("parses clean JSON without repairing", () => {
    const result = parseGenerationResponse(envelope(goodQuestion("Clean JSON question?")));
    expect(result.repair).toBe("none");
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
  });

  it("unwraps a markdown fence", () => {
    const text = "```json\n" + envelope(goodQuestion("Fenced question?")) + "\n```";
    const result = parseGenerationResponse(text);
    expect(result.repair).toBe("fence");
    expect(result.accepted).toHaveLength(1);
  });

  it("recovers JSON embedded in prose", () => {
    const text =
      "Sure! Here are the questions you asked for:\n\n" +
      envelope(goodQuestion("Prose-wrapped question?")) +
      "\n\nLet me know if you want more.";
    const result = parseGenerationResponse(text);
    expect(["slice", "fence", "none"]).toContain(result.repair);
    expect(result.accepted).toHaveLength(1);
  });

  it("tolerates trailing commas", () => {
    // A trailing comma after the object AND after the array.
    const text = `{"questions": [${JSON.stringify(goodQuestion("Trailing comma question?"))},],}`;
    const result = parseGenerationResponse(text);
    expect(result.accepted).toHaveLength(1);
  });

  it("recovers a response truncated mid-array, keeping the complete questions", () => {
    const complete = goodQuestion("Complete question before truncation?");
    // Cut the payload in the middle of the SECOND question.
    const text =
      `{"questions": [${JSON.stringify(complete)}, {"stem": "A question that got cut off half` +
      `way through because the model hit its token limit and stopped writ`;

    const result = parseGenerationResponse(text);
    expect(result.repair).toBe("closed");
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]!.draft.stem).toBe("Complete question before truncation?");
  });

  it("accepts a bare array instead of an envelope", () => {
    const text = JSON.stringify([goodQuestion("Bare array question?")]);
    const result = parseGenerationResponse(text);
    expect(result.accepted).toHaveLength(1);
  });

  it("accepts the array under a differently-named key", () => {
    const text = JSON.stringify({ items: [goodQuestion("Alternate key question?")] });
    const result = parseGenerationResponse(text);
    expect(result.accepted).toHaveLength(1);
  });

  it("throws a typed error when there is no JSON at all", () => {
    expect(() => parseGenerationResponse("I cannot help with that request.")).toThrow(
      GenerationParseError,
    );
  });

  it("throws when the payload has no questions array", () => {
    expect(() => parseGenerationResponse('{"notes": "nothing here"}')).toThrow(
      GenerationParseError,
    );
  });
});

describe("parseGenerationResponse — per-question validation", () => {
  it("keeps the good questions and reports each bad one separately", () => {
    const text = envelope(
      goodQuestion("Good question one?"),
      { ...goodQuestion("Only three options?"), options: [{ key: "A", body: "one" }] },
      { ...goodQuestion("Bad key?"), correct_option_key: "Z" },
      { ...goodQuestion("Short backstory?"), backstory: "too short" },
      goodQuestion("Good question two?"),
    );

    const result = parseGenerationResponse(text);

    expect(result.accepted).toHaveLength(2);
    expect(result.rejected).toHaveLength(3);

    // Every rejection carries readable errors and its index.
    for (const rejected of result.rejected) {
      expect(rejected.errors.length).toBeGreaterThan(0);
      expect(typeof rejected.index).toBe("number");
    }
    expect(result.rejected.map((r) => r.index)).toEqual([1, 2, 3]);
  });

  it("preserves the model's original object on a rejection, for the review UI", () => {
    const original = { ...goodQuestion("Preserved raw?"), options: [] };
    const result = parseGenerationResponse(envelope(original));
    expect(result.rejected[0]!.raw).toEqual(original);
  });

  it("carries the notes field through", () => {
    const text = JSON.stringify({
      questions: [goodQuestion("Noted question?")],
      notes: "I avoided version-number trivia as instructed.",
    });
    const result = parseGenerationResponse(text);
    expect(result.notes).toContain("avoided version-number trivia");
  });

  it("uses the fallback topic when the model omits one", () => {
    const question = { ...goodQuestion("Topic fallback question?") } as Record<string, unknown>;
    delete question.topic;
    const result = parseGenerationResponse(envelope(question), "Operating Systems");
    expect(result.accepted[0]!.draft.topic).toBe("Operating Systems");
  });
});
