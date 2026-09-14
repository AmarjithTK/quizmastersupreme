import { errorResponse, jsonResponse } from "@/lib/errors";
import { requireAdmin } from "@/modules/auth";
import { listDuplicateFlags, openDuplicateCount } from "@/modules/dedupe";
import { getDedupeThresholds } from "@/modules/settings";

/** GET /api/admin/duplicates?status=open — flags awaiting a decision. */
export async function GET(request: Request) {
  try {
    await requireAdmin(request);
    const status = new URL(request.url).searchParams.get("status") ?? "open";

    const [flags, open, thresholds] = await Promise.all([
      listDuplicateFlags({ status, limit: 100 }),
      openDuplicateCount(),
      getDedupeThresholds(),
    ]);

    return jsonResponse({ flags, open, thresholds });
  } catch (error) {
    return errorResponse(error);
  }
}
