/**
 * Google OIDC — authorization code flow with PKCE (S256).
 *
 * Flow:
 *   1. `/api/auth/google/start`  → buildAuthorizationUrl() → redirect to Google
 *   2. Google 302s the user back to the callback with `?code=...&state=...`
 *   3. `/api/auth/google/callback` → exchangeCodeForTokens() →
 *      verifyIdToken() → upsert user → create session
 *
 * `state` is stored as sha256(state) in D1 with its PKCE verifier, so a leaked
 * database row cannot forge a callback. The state row is single-use.
 */

import { createRemoteJWKSet, jwtVerify } from "jose";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { oauthStates } from "@/db/schema";
import { pkceChallenge, randomToken, sha256Hex } from "@/lib/crypto";
import { ApiError, unauthorized } from "@/lib/errors";

const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS_URI = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

// Fetched lazily once per isolate; jose re-reads it when a key id is unknown.
const googleJwks = createRemoteJWKSet(new URL(GOOGLE_JWKS_URI));

/** The identity claims we consume from Google's ID token. */
export type GoogleIdentity = {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
};

export class OAuthStateError extends ApiError {
  constructor(message = "The sign-in link was invalid or had expired. Please try again.") {
    super("UNAUTHORIZED", message);
  }
}

// ── Step 1: send the user to Google ─────────────────────────────────────────

export function buildAuthorizationUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const params = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state: opts.state,
    // PKCE S256: the code_verifier never leaves the server.
    code_challenge: opts.codeChallenge,
    code_challenge_method: "S256",
    prompt: "select_account",
    access_type: "online",
  });
  return `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`;
}

/**
 * Create the state row and return the raw state + verifier to embed in the
 * redirect URL, before the callback consumes them. 10-minute expiry.
 */
export async function createOAuthState(redirectTo: string | null): Promise<{
  state: string;
  codeChallenge: string;
  codeVerifier: string;
}> {
  const state = randomToken(24);
  const codeVerifier = randomToken(48);
  const now = Date.now();

  await db()
    .insert(oauthStates)
    .values({
      // Store the hash, never the raw state value.
      id: await sha256Hex(state),
      codeVerifier,
      redirectTo,
      expiresAt: now + 10 * 60 * 1000,
      createdAt: now,
    });

  return { state, codeChallenge: await pkceChallenge(codeVerifier), codeVerifier };
}

/**
 * Single-use state consumption. Deletes the row even on failure so a
 * replayed callback cannot brute-force the same state.
 */
export async function consumeOAuthState(
  state: string,
): Promise<{ codeVerifier: string; redirectTo: string | null }> {
  const rows = await db()
    .select()
    .from(oauthStates)
    .where(eq(oauthStates.id, await sha256Hex(state)))
    .limit(1);

  const row = rows[0];
  if (row) {
    await db().delete(oauthStates).where(eq(oauthStates.id, row.id));
  }
  if (!row) throw new OAuthStateError();
  if (row.expiresAt < Date.now()) throw new OAuthStateError();

  return { codeVerifier: row.codeVerifier, redirectTo: row.redirectTo };
}

// ── Step 3: exchange the code, verify the token ─────────────────────────────

export async function exchangeCodeForTokens(opts: {
  code: string;
  codeVerifier: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<{ idToken: string }> {
  const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: opts.code,
      code_verifier: opts.codeVerifier,
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      redirect_uri: opts.redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!response.ok) {
    // Never echo Google's response body to the browser; it can contain error
    // details we do not need to leak.
    throw new ApiError("UNAUTHORIZED", "Google rejected the sign-in attempt.");
  }

  const data = (await response.json()) as { id_token?: string };
  if (!data.id_token) {
    throw new ApiError("UNAUTHORIZED", "Google did not return an identity token.");
  }
  return { idToken: data.id_token };
}

/**
 * Verify the ID token: signature against Google's JWKS, issuer, audience and
 * expiry (jwtVerify covers exp/iat/nbf by default). We then extract exactly the
 * claims our app is allowed to rely on and nothing else.
 *
 * `jwks` is injectable so tests can verify against a locally generated keypair
 * instead of a live Google fetch. Defaults to Google's certificate endpoint.
 */
export async function verifyIdToken(
  idToken: string,
  clientId: string,
  jwks: Parameters<typeof jwtVerify>[1] = googleJwks,
): Promise<GoogleIdentity> {
  let payload;
  try {
    ({ payload } = await jwtVerify(idToken, jwks, {
      issuer: GOOGLE_ISSUERS,
      audience: clientId,
    }));
  } catch {
    throw unauthorized("Your Google sign-in could not be verified.");
  }

  if (typeof payload.sub !== "string" || typeof payload.email !== "string") {
    throw unauthorized("Google did not return the required identity claims.");
  }

  return {
    sub: payload.sub,
    email: payload.email.trim().toLowerCase(),
    emailVerified: payload.email_verified === true,
    name: typeof payload.name === "string" ? payload.name : null,
    picture: typeof payload.picture === "string" ? payload.picture : null,
  };
}