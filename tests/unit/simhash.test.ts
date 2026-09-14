import { describe, expect, it } from "vitest";
import {
  fromHex64,
  hammingDistance,
  simhash64,
  simhashHex,
  SIMHASH_NEAR_DUPLICATE_MAX_DISTANCE,
  toHex64,
} from "@/modules/dedupe/simhash";

describe("simhash64", () => {
  it("is deterministic", () => {
    const text = "Who created the Linux kernel?";
    expect(simhash64(text)).toBe(simhash64(text));
  });

  it("emits a 16-char hex string", () => {
    expect(simhashHex("Who created Linux?")).toMatch(/^[0-9a-f]{16}$/);
  });

  it("round-trips through hex", () => {
    const value = simhash64("Some question stem here");
    expect(fromHex64(toHex64(value))).toBe(value);
  });
});

describe("hammingDistance", () => {
  it("is zero for identical values and 64 for bitwise complements", () => {
    expect(hammingDistance(0n, 0n)).toBe(0);
    expect(hammingDistance(0n, 0xffffffffffffffffn)).toBe(64);
  });

  it("counts set bits correctly", () => {
    expect(hammingDistance(0b1011n, 0b0010n)).toBe(2);
  });
});

describe("simhash near-duplicate behaviour", () => {
  // These expectations are the MEASURED bands, not guesses. See the table in
  // src/modules/dedupe/simhash.ts.
  it("gives a small distance for a one-word spelling variant", () => {
    const a = simhash64("Which organisation developed the Multics operating system?");
    const b = simhash64("Which organization developed the Multics operating system");
    expect(hammingDistance(a, b)).toBeLessThanOrEqual(SIMHASH_NEAR_DUPLICATE_MAX_DISTANCE);
  });

  it("gives a small distance for a paraphrase", () => {
    const a = simhash64("Who created the Linux kernel?");
    const b = simhash64("Who was the original developer of the Linux kernel?");
    expect(hammingDistance(a, b)).toBeLessThanOrEqual(SIMHASH_NEAR_DUPLICATE_MAX_DISTANCE);
  });

  it("separates near-duplicates from merely same-topic questions", () => {
    const original = simhash64("Who created the Linux kernel?");
    const paraphrase = simhash64("Who was the original developer of the Linux kernel?");
    const sameTopic = simhash64("In which year was Linux first released?");
    const unrelated = simhash64("What is the SI unit of force?");

    const paraphraseDistance = hammingDistance(original, paraphrase);
    const sameTopicDistance = hammingDistance(original, sameTopic);
    const unrelatedDistance = hammingDistance(original, unrelated);

    // The whole point: a paraphrase must sit clearly inside the near threshold
    // while a genuinely different fact does not.
    expect(paraphraseDistance).toBeLessThanOrEqual(SIMHASH_NEAR_DUPLICATE_MAX_DISTANCE);
    expect(sameTopicDistance).toBeGreaterThan(SIMHASH_NEAR_DUPLICATE_MAX_DISTANCE);
    expect(unrelatedDistance).toBeGreaterThan(sameTopicDistance);
  });
});
