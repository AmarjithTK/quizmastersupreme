import { clearSessionCookie, destroySession, getTokenFromRequest } from "@/modules/auth";

/** Signs the user out: destroys the D1 session row and clears the cookie. */
export async function POST(request: Request) {
  const token = getTokenFromRequest(request);
  if (token) {
    await destroySession(token);
  }
  return new Response(null, {
    status: 303,
    headers: { Location: "/", "Set-Cookie": clearSessionCookie() },
  });
}