import { errorResponse, jsonResponse } from "@/lib/errors";
import { requireAdmin } from "@/modules/auth";
import { approveGenerationPlan, getJob } from "@/modules/ai";
import { dispatchGenerationWorkflow } from "@/modules/ai/orchestration";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    const actor = await requireAdmin(request);
    const { id } = await context.params;
    const job = await approveGenerationPlan(await getJob(id), actor.id);
    const scheduled = await dispatchGenerationWorkflow("approve", id);
    return jsonResponse({ job, orchestration: scheduled ? "workflow" : "manual" });
  } catch (error) {
    return errorResponse(error);
  }
}
