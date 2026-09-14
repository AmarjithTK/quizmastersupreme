import { errorResponse } from "@/lib/errors";
import { enforceRateLimit } from "@/modules/rate-limit";
import {
  authConfig,
  buildAuthorizationUrl,
  createOAuthState,
  googleEnabled,
  sanitizeRedirect,
} from "@/modules/auth";

/**
 * Step 1 of the Google OIDC flow (PLAN.md §16.1, auth.google.ts).
 *
 * Redirects the user to Google with `state` (sha256-stored) and a PKCE
 * challenge. The verifier exists only server-side, in the D1 oauth_states row.
 */

export async function GET(request: Request) {
  try {
    enforceRateLimit(request, "auth");
    if (!googleEnabled()) {
      const login = new URL("/login", request.url);
      login.searchParams.set("error", "Google sign-in is not configured yet.");
      return Response.redirect(login, 307);
    }

    const requestUrl = new URL(request.url);
    const redirectTo = sanitizeRedirect(requestUrl.searchParams.get("redirect"), requestUrl.origin);

    const { state, codeChallenge } = await createOAuthState(redirectTo);
    const { clientId, redirectUri } = authConfig();

    return Response.redirect(
      buildAuthorizationUrl({ clientId, redirectUri, state, codeChallenge }),
      302,
    );
  } catch (error) {
    return errorResponse(error);
  }
}