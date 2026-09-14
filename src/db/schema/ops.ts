/**
 * Operational tables: the admin audit trail and runtime settings.
 * PLAN.md §7.8, §13.4 (tunable thresholds live in app_settings).
 */

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    actorId: text("actor_id"),
    /** e.g. 'question.approve', 'category.delete' */
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    beforeJson: text("before_json"),
    afterJson: text("after_json"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("ix_audit_entity").on(t.entityType, t.entityId, t.createdAt),
    index("ix_audit_actor").on(t.actorId, t.createdAt),
  ],
);

export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  /** JSON-encoded value. */
  value: text("value").notNull(),
  updatedAt: integer("updated_at").notNull(),
  updatedBy: text("updated_by"),
});

export type AuditLogRow = typeof auditLog.$inferSelect;
export type AppSetting = typeof appSettings.$inferSelect;
