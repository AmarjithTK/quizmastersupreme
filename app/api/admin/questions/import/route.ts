import { errorResponse, jsonResponse } from "@/lib/errors";
import { requireAdmin } from "@/modules/auth";
import { importQuestions } from "@/modules/questions";
import type { QuestionStatus } from "@/db/schema";

/**
 * POST /api/admin/questions/import
 *
 * Accepts either a raw `text/csv` body (what the upload form sends) or JSON
 * `{ csv, status, dryRun }`.
 *
 * Every row comes back in the report with a status — created, duplicate,
 * duplicate-within-the-file, or invalid with reasons. Nothing is dropped
 * silently, which is the whole point of the milestone's exit test.
 *
 * `dryRun` validates and reports without writing, so an admin can check a file
 * before committing it.
 */

const MAX_BYTES = 4 * 1024 * 1024; // 4 MB — roughly 10k questions.

export async function POST(request: Request) {
  try {
    const actor = await requireAdmin(request);

    const contentType = request.headers.get("content-type") ?? "";
    let csv = "";
    let status: QuestionStatus = "active";
    let dryRun = false;

    if (contentType.includes("application/json")) {
      const body = (await request.json()) as Record<string, unknown>;
      csv = typeof body.csv === "string" ? body.csv : "";
      if (typeof body.status === "string") status = body.status as QuestionStatus;
      dryRun = body.dryRun === true;
    } else {
      csv = await request.text();
      const params = new URL(request.url).searchParams;
      if (params.get("status")) status = params.get("status") as QuestionStatus;
      dryRun = params.get("dryRun") === "true";
    }

    if (!csv.trim()) {
      return jsonResponse(
        { error: { code: "VALIDATION", message: "No CSV content was provided." } },
        { status: 422 },
      );
    }
    if (csv.length > MAX_BYTES) {
      return jsonResponse(
        {
          error: {
            code: "VALIDATION",
            message: `That file is larger than ${Math.round(MAX_BYTES / 1024 / 1024)} MB. Split it and import in parts.`,
          },
        },
        { status: 413 },
      );
    }

    if (!["active", "rejected", "archived"].includes(status)) {
      return jsonResponse(
        {
          error: {
            code: "VALIDATION",
            message: "Imported questions may only be active, rejected or archived.",
          },
        },
        { status: 422 },
      );
    }

    const report = await importQuestions(csv, actor.id, { status, dryRun });
    return jsonResponse({ report }, { status: 200 });
  } catch (error) {
    return errorResponse(error);
  }
}
