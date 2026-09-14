/**
 * Public surface of the auth module.
 * Other modules call these — never `service.ts` internals or the tables.
 */

export {
  authConfig,
  googleEnabled,
  type AuthConfig,
} from "./config";
export {
  buildAuthorizationUrl,
  createOAuthState,
  consumeOAuthState,
  exchangeCodeForTokens,
  verifyIdToken,
  OAuthStateError,
  type GoogleIdentity,
} from "./google";
export {
  createSession,
  destroySession,
  findSessionUserId,
  getTokenFromRequest,
  sessionCookie,
  clearSessionCookie,
  SESSION_COOKIE_NAME,
} from "./session";
export {
  upsertUserFromGoogle,
  getCurrentUserFromRequest,
  getSessionUserFromToken,
  requireUser,
  requireAdmin,
  publicUser,
  sanitizeRedirect,
} from "./service";
export type { User } from "@/db/schema";