/**
 * WebCrypto helpers shared across modules.
 *
 * Lives in `lib/` rather than in a domain module because BOTH `modules/auth`
 * (session tokens) and `modules/questions` (dedupe hashes) need sha256 —
 * and modules must never import each other's internals (PLAN.md §2.4).
 */

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return bytesToHex(new Uint8Array(digest));
}

export function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** URL-safe base64 without padding — the encoding OAuth PKCE and JWT use. */
export function base64UrlEncode(input: Uint8Array | string): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(input: string): Uint8Array {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** Cryptographically random URL-safe token. Default 32 bytes = 256 bits. */
export function randomToken(bytes = 32): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return base64UrlEncode(buffer);
}

/**
 * Constant-time string comparison.
 *
 * Used for comparing secrets. A plain `===` short-circuits on the first
 * differing byte, which leaks how much of a guess was correct.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  // Compare lengths without branching on content.
  let mismatch = left.length === right.length ? 0 : 1;
  const max = Math.max(left.length, right.length);
  for (let i = 0; i < max; i++) {
    mismatch |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return mismatch === 0;
}

/** PKCE challenge: base64url(sha256(verifier)). */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}
