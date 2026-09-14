import { jsonResponse } from "@/lib/errors";
import { getCurrentUserFromRequest, publicUser } from "@/modules/auth";

/**
 * Returns the current user, or `{ "user": null }`. 200-with-null is deliberate:
 * the client can always parse the same shape and branch on `user`.
 */
export async function GET(request: Request) {
  const user = await getCurrentUserFromRequest(request);
  return jsonResponse({ user: user ? publicUser(user) : null });
}