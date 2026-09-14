import { ApiError } from "@/lib/errors";
import {
  authConfig,
  consumeOAuthState,
  createSession,
  exchangeCodeForTokens,
  sanitizeRedirect,
  sessionCookie,
  upsertUserFromGoogle,
  verifyIdToken,
} from "@/modules/auth";

/**
 * Step 3 of the Google OIDC flow: the user arrives back with ?code&state.
 *
 * A failure here NEVER renders as JSON to the browser — the user is redirected
 * to /login with a human-readable error. Raw provider error text is never
 * echoed back (see exchangeCodeForTokens).
 */

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  const fail = (message: string) => {
    const login = new URL("/login", request.url);
    login.searchParams.set("error", message);
    return Response.redirect(login, 303);
  };

  if (!code || !state) {
    return fail("The sign-in did not complete. Please try again.");
  }

  try {
    // Single-use; throws OAuthStateError on replay, tamper or expiry.
    const { codeVerifier, redirectTo } = await consumeOAuthState(state);
    const config = authConfig();

    const { idToken } = await exchangeCodeForTokens({
      code,
      codeVerifier,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      redirectUri: config.redirectUri,
    });

    const identity = await verifyIdToken(idToken, config.clientId);
    const user = await upsertUserFromGoogle(identity);

    const { rawToken, expiresAt } = await createSession(user.id, {
      userAgent: request.headers.get("user-agent"),
    });

    return new Response(null, {
      status: 303,
      headers: {
        Location: sanitizeRedirect(redirectTo, url.origin),
        "Set-Cookie": sessionCookie(rawToken, expiresAt),
      },
    });
  } catch (error) {
    if (error instanceof ApiError && error.code === "UNAUTHORIZED") {
      return fail(error.message);
    }
    console.error("OAuth callback failed", error);
    return fail("Sign-in failed. Please try again.");
  }
}