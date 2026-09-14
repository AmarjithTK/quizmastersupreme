import { errorResponse, jsonResponse } from "@/lib/errors";
import { requireAdmin } from "@/modules/auth";
import { promptVersionStats } from "@/modules/ai";

/**
 * GET /api/admin/generation-jobs/stats
 *
 * Acceptance-rate reporting by prompt_version (M13 exit test). Lets an admin
 * see, per prompt version, how many candidates survived validation, were
 * flagged as duplicates, and — the number that actually matters — what share
 * of human-decided candidates were approved.
 */
export async function GET(request: Request) {
  try {
    await requireAdmin(request);
    return jsonResponse({ stats: await promptVersionStats() });
  } catch (error) {
    return errorResponse(error);
  }
}