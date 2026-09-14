import { describe, expect, it } from "vitest";
import {
  base64UrlDecode,
  base64UrlEncode,
  pkceChallenge,
  randomToken,
  sha256Hex,
  timingSafeEqual,
} from "@/lib/crypto";

describe("base64Url", () => {
  it("round-trips arbitrary bytes", () => {
    const input = new TextEncoder().encode("hello \u{1F600} quiz");
    expect(base64UrlDecode(base64UrlEncode(input))).toEqual(input);
  });

  it("uses the URL-safe alphabet without padding", () => {
    const encoded = base64UrlEncode(new Uint8Array([0xfb, 0xff, 0x00]));
    expect(encoded).toBe("-_8A");
    expect(encoded).not.toMatch(/[+/=]/);
  });
});

describe("randomToken", () => {
  it("produces distinct URL-safe tokens of the requested size", () => {
    const a = randomToken(32);
    const b = randomToken(32);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    // 32 bytes → 43 base64url characters.
    expect(a.length).toBe(43);
  });
});

describe("timingSafeEqual", () => {
  it("returns true for identical strings", () => {
    expect(timingSafeEqual("applesauce", "applesauce")).toBe(true);
  });

  it("returns false for different strings of equal length", () => {
    expect(timingSafeEqual("applesauce", "applebauce")).toBe(false);
  });

  it("returns false for different lengths", () => {
    expect(timingSafeEqual("a", "ab")).toBe(false);
  });
});

describe("pkceChallenge", () => {
  it("is deterministic for the same verifier and produces 43 chars", async () => {
    const verifier = randomToken(48);
    const a = await pkceChallenge(verifier);
    const b = await pkceChallenge(verifier);
    expect(a).toBe(b);
    // base64url(sha256(x)) is always 43 chars.
    expect(a.length).toBe(43);
  });

  it("differs across verifiers", async () => {
    expect(await pkceChallenge("v1")).not.toBe(await pkceChallenge("v2"));
  });
});

describe("sha256Hex", () => {
  it("matches the published SHA-256 of 'abc'", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});