/**
 * Reads the signed-in user for SERVER COMPONENTS.
 *
 * Route handlers already have the Request (use getCurrentUserFromRequest);
 * server components do not, so this adapts next/headers' cookie store onto the
 * same session resolution. Lives in lib/server because it is a Next-specific
 * adapter: the auth module itself stays framework-agnostic (§5 layout note).
 */

import { cookies } from "next/headers";
import { getSessionUserFromToken, SESSION_COOKIE_NAME, type User } from "@/modules/auth";

export async function getCurrentPageUser(): Promise<User | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;
  return getSessionUserFromToken(token);
}