/**
 * Auth configuration, resolved from bindings/vars per request.
 *
 * Secrets are REAL secrets in production (`wrangler secret put`), never plain
 * `vars` — those are readable in the dashboard. `GOOGLE_CLIENT_ID` is not a
 * secret (it ships in every redirect URL), but the client secret is.
 *
 * Google-only auth (decision D-2) means we never run a KDF in the Worker, so
 * PLAN.md §22 R-1 (the Workers Free 10 ms CPU cap) does not apply to auth.
 */

import { bindings } from "@/lib/cloudflare/bindings";

export type AuthConfig = {
  clientId: string;
  clientSecret: string;
  /** Absolute URL Google must redirect the user back to after consent. */
  redirectUri: string;
  baseUrl: string;
  /** Lowercased. Subjects in this list get the admin role on first login. */
  adminEmails: string[];
};

function baseUrl(): string {
  return (bindings().APP_BASE_URL as string) || "http://localhost:3000";
}

export function authConfig(): AuthConfig {
  const b = bindings();
  const url = baseUrl();
  return {
    clientId: b.GOOGLE_CLIENT_ID,
    clientSecret: b.GOOGLE_CLIENT_SECRET,
    redirectUri: `${url}/api/auth/google/callback`,
    baseUrl: url,
    adminEmails: (b.ADMIN_EMAILS as string ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  };
}

/** True when both the client id and client secret are configured. */
export function googleEnabled(): boolean {
  const { clientId, clientSecret } = authConfig();
  return Boolean(clientId && clientSecret);
}