/**
 * Audit trail — one write function called by every admin mutation (§7.8), plus
 * the read side so the trail is actually inspectable.
 *
 * An audit log nobody can look at is not a control, it is a write-only table.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { auditLog, newId, users } from "@/db/schema";

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

export type AuditEntry = {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  actorId: string | null;
  actorEmail: string | null;
  actorName: string | null;
  beforeJson: string | null;
  afterJson: string | null;
  createdAt: number;
};

export async function listAuditLog(
  options: { page?: number; pageSize?: number; entityType?: string; action?: string } = {},
): Promise<{ rows: AuditEntry[]; total: number; page: number; pageSize: number }> {
  const page = Math.max(1, options.page ?? 1);
  const pageSize = Math.min(100, Math.max(5, options.pageSize ?? 30));

  const filters = [];
  if (options.entityType) filters.push(eq(auditLog.entityType, options.entityType));
  if (options.action) filters.push(eq(auditLog.action, options.action));
  const where = filters.length > 0 ? and(...filters) : undefined;

  const [rows, countRow] = await Promise.all([
    db()
      .select({
        id: auditLog.id,
        action: auditLog.action,
        entityType: auditLog.entityType,
        entityId: auditLog.entityId,
        actorId: auditLog.actorId,
        actorEmail: users.email,
        actorName: users.displayName,
        beforeJson: auditLog.beforeJson,
        afterJson: auditLog.afterJson,
        createdAt: auditLog.createdAt,
      })
      .from(auditLog)
      // LEFT JOIN so an audit row survives its actor being deleted.
      .leftJoin(users, eq(users.id, auditLog.actorId))
      .where(where)
      .orderBy(desc(auditLog.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db().select({ n: sql<number>`count(*)` }).from(auditLog).where(where),
  ]);

  return { rows, total: Number(countRow[0]?.n ?? 0), page, pageSize };
}

/** Distinct entity types present in the log, for the filter chips. */
export async function listAuditEntityTypes(): Promise<string[]> {
  const rows = await db()
    .selectDistinct({ entityType: auditLog.entityType })
    .from(auditLog)
    .orderBy(auditLog.entityType);
  return rows.map((r) => r.entityType);
}
