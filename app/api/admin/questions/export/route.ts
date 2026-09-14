import { errorResponse } from "@/lib/errors";
import { requireAdmin } from "@/modules/auth";
import { exportQuestionsCsv } from "@/modules/questions";

/**
 * GET /api/admin/questions/export — the question bank as CSV.
 *
 * Honours the same filters as the bank screen, and the columns match the
 * importer exactly, so an export can be edited and fed straight back in.
 * Cells are guarded against spreadsheet formula injection (§16.3).
 */
export async function GET(request: Request) {
  try {
    await requireAdmin(request);
    const params = new URL(request.url).searchParams;

    const { csv, count } = await exportQuestionsCsv({
      q: params.get("q") ?? undefined,
      status: params.get("status") ?? undefined,
      difficulty: params.get("difficulty") ?? undefined,
      topic: params.get("topic") ?? undefined,
      origin: params.get("origin") ?? undefined,
      setId: params.get("setId") ?? undefined,
    });

    const stamp = new Date().toISOString().slice(0, 10);
    return new Response(csv, {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="questions-${stamp}-${count}.csv"`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
