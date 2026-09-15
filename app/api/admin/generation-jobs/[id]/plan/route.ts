import { errorResponse, jsonResponse, validationError } from "@/lib/errors";
import { enforceRateLimit } from "@/modules/rate-limit";
import { requireAdmin } from "@/modules/auth";
import {
  configuredProvider,
  getJob,
  planGenerationJob,
  r2RawStorage,
  saveGenerationPlan,
} from "@/modules/ai";
import { z } from "zod";

const PlanEditSchema = z.object({
  blueprint: z.unknown(),
  groundingMode: z.enum(["off", "single"]).nullable().optional(),
}).strict();

type RouteContext = { params: Promise<{ id: string }> };

/** Build a fresh, strict blueprint without starting generation. */
export async function POST(request: Request, context: RouteContext) {
  try {
    await requireAdmin(request);
    enforceRateLimit(request, "admin");
    const { id } = await context.params;
    const job = await planGenerationJob(await getJob(id), {
      provider: configuredProvider(),
      storage: r2RawStorage(),
    });
    return jsonResponse({ job, blueprint: job.blueprintJson ? JSON.parse(job.blueprintJson) : null });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Save reviewer edits as a new canonical revision. */
export async function PATCH(request: Request, context: RouteContext) {
  try {
    const actor = await requireAdmin(request);
    const { id } = await context.params;
    const parsed = PlanEditSchema.safeParse(await request.json());
    if (!parsed.success) throw validationError(parsed.error.issues[0]?.message ?? "A blueprint is required.");
    const job = await saveGenerationPlan(await getJob(id), parsed.data.blueprint, actor.id, parsed.data.groundingMode);
    return jsonResponse({ job, blueprint: job.blueprintJson ? JSON.parse(job.blueprintJson) : null });
  } catch (error) {
    return errorResponse(error);
  }
}
