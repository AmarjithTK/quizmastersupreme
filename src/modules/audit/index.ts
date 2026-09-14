/**
 * Audit trail — one function, called by every admin mutation (PLAN.md §7.8).
 * Owns the `audit_log` table.
 */

import { db } from "@/db/client";
import { auditLog, newId } from "@/db/schema";

export async function recordAudit(
  actorId: string | null,
  action: string,
  entityType: string,
  entityId: string | null,
  before?: unknown,
  after?: unknown,
): Promise<void> {
  await db().insert(auditLog).values({
    id: newId(),
    actorId,
    action,
    entityType,
    entityId,
    beforeJson: before === undefined ? null : JSON.stringify(before),
    afterJson: after === undefined ? null : JSON.stringify(after),
    createdAt: Date.now(),
  });
}