import { describe, expect, it } from "vitest";
import {
  computeDedupeHashes,
  contentFingerprint,
  normalizeStem,
  slugify,
} from "@/modules/questions/normalize";

describe("normalizeStem", () => {
  it("collapses case, punctuation and whitespace", () => {
    expect(normalizeStem("Who created Linux?")).toBe("who created linux");
    expect(normalizeStem("who   created   linux")).toBe("who created linux");
    expect(normalizeStem("Who created Linux")).toBe("who created linux");
  });

  it("deletes apostrophes instead of splitting the word", () => {
    // "Kerala's" and "Keralas" must normalize identically, so the apostrophe is
    // removed rather than turned into a separator.
    expect(normalizeStem("What is Kerala\u2019s capital?")).toBe("what is keralas capital");
    expect(normalizeStem("What is Keralas capital?")).toBe("what is keralas capital");
  });

  it("preserves non-ASCII letters AND combining marks", () => {
    expect(normalizeStem("Kérala")).toBe("kérala");
    // Regression guard: Indic vowel signs and the anusvara are Unicode Marks
    // (category M), not Letters (L). A [^\p{L}\p{N}\s] class silently shreds
    // Malayalam into broken text, which would corrupt every stem if Malayalam
    // content is ever added (PLAN.md §24 D-7).
    expect(normalizeStem("മലയാളം")).toBe("മലയാളം");
    expect(normalizeStem("മലയാളം ക്വിസ്")).toBe("മലയാളം ക്വിസ്");
  });

  it("is idempotent", () => {
    const once = normalizeStem("  Who created Linux??  ");
    expect(normalizeStem(once)).toBe(once);
  });
});

describe("contentFingerprint", () => {
  it("is invariant to option order", () => {
    const a = contentFingerprint("Pick one", ["alpha", "beta", "gamma", "delta"]);
    const b = contentFingerprint("Pick one", ["delta", "gamma", "beta", "alpha"]);
    expect(a).toBe(b);
  });

  it("changes when an option body changes", () => {
    const a = contentFingerprint("Pick one", ["alpha", "beta", "gamma", "delta"]);
    const b = contentFingerprint("Pick one", ["alpha", "beta", "gamma", "epsilon"]);
    expect(a).not.toBe(b);
  });
});

describe("computeDedupeHashes", () => {
  // The headline promise of dedupe layer 1 (PLAN.md §13.2).
  it("gives the SAME normalizedHash for trivial rewordings", async () => {
    const a = await computeDedupeHashes("Who created Linux?", ["A", "B", "C", "D"]);
    const b = await computeDedupeHashes("who created linux", ["A", "B", "C", "D"]);
    expect(a.normalizedHash).toBe(b.normalizedHash);
  });

  it("gives DIFFERENT hashes for genuinely different questions", async () => {
    const a = await computeDedupeHashes("Who created Linux?", ["A", "B", "C", "D"]);
    const b = await computeDedupeHashes("In which year was Linux released?", ["A", "B", "C", "D"]);
    expect(a.normalizedHash).not.toBe(b.normalizedHash);
  });

  it("returns 64-char lowercase hex", async () => {
    const { normalizedHash, contentHash } = await computeDedupeHashes("Q", ["A"]);
    expect(normalizedHash).toMatch(/^[0-9a-f]{64}$/);
    expect(contentHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("slugify", () => {
  it("produces url-safe slugs", () => {
    expect(slugify("Kerala State Mock Set 1")).toBe("kerala-state-mock-set-1");
    expect(slugify("Units & Measurement")).toBe("units-measurement");
  });
});
