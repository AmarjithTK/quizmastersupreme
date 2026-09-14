import { errorResponse, jsonResponse } from "@/lib/errors";
import { logInfo } from "@/lib/logger";
import { requireAdmin } from "@/modules/auth";
import { buildCoverageDigest, estimateTokens } from "@/modules/ai";

/**
 * POST /api/admin/generation-jobs/preview-digest
 *
 * body: { topic, subtopics?, maxTokens?, includeExamples? }
 *
 * Shows the exact "ALREADY COVERED" block that would go into a generation
 * prompt, with its token estimate — without spending anything. An admin should
 * always be able to see what they are paying for before they pay for it
 * (PLAN.md §12.6).
 */
export async function POST(request: Request) {
  try {
    await requireAdmin(request);
    const body = (await request.json()) as Record<string, unknown>;

    const topic = typeof body.topic === "string" ? body.topic.trim() : "";
    if (!topic) {
      return jsonResponse(
        { error: { code: "VALIDATION", message: "A topic is required." } },
        { status: 422 },
      );
    }

    const digest = await buildCoverageDigest({
      topic,
      subtopics: Array.isArray(body.subtopics)
        ? body.subtopics.filter((s): s is string => typeof s === "string")
        : null,
      maxTokens: typeof body.maxTokens === "number" ? body.maxTokens : undefined,
      includeExamples: body.includeExamples === true,
    });

    logInfo("route", "preview-digest", { topic, questions: digest.questionCount, concepts: digest.conceptCount, tokens: digest.estimatedTokens });
    return jsonResponse({
      digest,
      // A rough input-token figure so the cost is visible before generating.
      estimatedPromptTokens: digest.estimatedTokens + estimateTokens(topic) + 400,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
