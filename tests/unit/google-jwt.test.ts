/**
 * ID token verification, exercised against a LOCALLY GENERATED keypair.
 *
 * No network, no Google: this proves the verification logic (issuer, audience,
 * expiry, signature, kid selection) without depending on a live fetch. The
 * production path uses the same function with Google's real JWKS provider.
 */

import { exportJWK, generateKeyPair, importJWK, SignJWT, type JWK } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { verifyIdToken, type GoogleIdentity } from "@/modules/auth";

const CLIENT_ID = "test-client.apps.googleusercontent.com";
const ISSUER = "https://accounts.google.com";

async function buildToken(claims: Record<string, unknown>, opts?: {
  issuer?: string;
  audience?: string | string[];
  expiresIn?: string;
}): Promise<string> {
  let token = new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(opts?.issuer ?? ISSUER)
    .setAudience(opts?.audience ?? CLIENT_ID)
    .setIssuedAt(Math.floor(Date.now() / 1000));

  if (opts?.expiresIn) token = token.setExpirationTime(opts.expiresIn);
  return token.sign(privateKey!);
}

let privateKey: CryptoKey | null = null;
let publicJwk: JWK | null = null;

const jwksProvider = async (header: { kid?: string }) => {
  if (!header || header.kid !== "test-key") throw new Error("unknown kid");
  // exportJWK omits `alg`; importJWK needs it explicitly for RSA keys.
  return (await importJWK(publicJwk!, "RS256")) as CryptoKey;
};

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey as CryptoKey;
  publicJwk = await exportJWK(pair.publicKey as CryptoKey);
});

describe("verifyIdToken", () => {
  it("returns the trusted claims for a valid token", async () => {
    const token = await buildToken({
      sub: "google-1234",
      email: "Dev.Sharma@Example.COM",
      email_verified: true,
      name: "Dev Sharma",
      picture: "https://photos.example.com/dev.jpg",
    });

    const identity: GoogleIdentity = await verifyIdToken(token, CLIENT_ID, jwksProvider);

    expect(identity).toEqual({
      sub: "google-1234",
      // Emails are lowercased and trimmed before they are ever stored.
      email: "dev.sharma@example.com",
      emailVerified: true,
      name: "Dev Sharma",
      picture: "https://photos.example.com/dev.jpg",
    });
  });

  it("rejects a token issued for another audience", async () => {
    const token = await buildToken({ sub: "s", email: "a@b.com" }, {
      audience: "someone-else.apps.googleusercontent.com",
    });
    await expect(verifyIdToken(token, CLIENT_ID, jwksProvider)).rejects.toThrow();
  });

  it("rejects a token from another issuer", async () => {
    const token = await buildToken({ sub: "s", email: "a@b.com" }, {
      issuer: "https://evil.example.com",
    });
    await expect(verifyIdToken(token, CLIENT_ID, jwksProvider)).rejects.toThrow();
  });

  it("rejects an expired token", async () => {
    const expired = await buildToken({ sub: "s", email: "a@b.com" }, { expiresIn: "-1h" });
    await expect(verifyIdToken(expired, CLIENT_ID, jwksProvider)).rejects.toThrow();
  });

  it("rejects a tampered token", async () => {
    const token = await buildToken({ sub: "s", email: "a@b.com" });
    // Flip a character in the payload section.
    const tampered = token.slice(0, -4) + (token.endsWith("AAAA") ? "BBBB" : "AAAA");
    await expect(verifyIdToken(tampered, CLIENT_ID, jwksProvider)).rejects.toThrow();
  });

  it("rejects a token lacking the sub or email claim", async () => {
    const token = await buildToken({ name: "no identity" });
    await expect(verifyIdToken(token, CLIENT_ID, jwksProvider)).rejects.toThrow();
  });
});