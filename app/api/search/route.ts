import { errorResponse, jsonResponse } from "@/lib/errors";
import { searchSets } from "@/modules/search";

/**
 * GET /api/search?q= — find published sets by question text, set title or
 * subject name.
 *
 * Public on purpose: it only ever reads PUBLISHED content, so it exposes
 * nothing a signed-out visitor could not already browse to.
 */
export async function GET(request: Request) {
  try {
    const q = new URL(request.url).searchParams.get("q") ?? "";
    const sets = await searchSets(q, 20);
    return jsonResponse({ query: q.trim(), count: sets.length, sets });
  } catch (error) {
    return errorResponse(error);
  }
}
