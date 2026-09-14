/**
 * Backup & restore (M14).
 *
 * The product's entire value is the question bank (PLAN.md risk R-12), so the
 * backup path is not a checkbox — it is a tested function: `exportDatabase`
 * dumps every table, `importDatabase` wipes and restores it, and the
 * integration test actually REHEARSES a restore (that is the M14 exit test).
 *
 * Formats: JSON with one array per table.
 *
 * Ordering is explicit and FK-safe: tables are listed parents-first so a
 * restore can insert children after their parents exist, and the wipe deletes
 * children before parents. FTS5 (`questions_fts`) is NOT backed up: it is
 * trigger-maintained, so wiping `questions` clears it and the insert triggers
 * repopulate it (verified by the rehearsal test).
 */

import { sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@/db/schema";

/** Parents-first. Restore inserts in this order; wipe deletes in reverse. */
export const TABLE_ORDER = [
  "categories",
  "quizSets",
  "questions",
  "questionOptions",
  "questionSetQuestions",
  "users",
  "authSessions",
  "oauthStates",
  "quizAttempts",
  "quizAttemptAnswers",
  "userQuestionSeen",
  "userSetStats",
  "appSettings",
  "auditLog",
  "aiGenerationJobs",
  "aiCandidates",
  "questionEmbeddings",
  "duplicateFlags",
] as const;

type TableName = (typeof TABLE_ORDER)[number];

const TABLES: Record<TableName, (typeof schema)[TableName]> = {
  categories: schema.categories,
  quizSets: schema.quizSets,
  questions: schema.questions,
  questionOptions: schema.questionOptions,
  questionSetQuestions: schema.questionSetQuestions,
  users: schema.users,
  authSessions: schema.authSessions,
  oauthStates: schema.oauthStates,
  quizAttempts: schema.quizAttempts,
  quizAttemptAnswers: schema.quizAttemptAnswers,
  userQuestionSeen: schema.userQuestionSeen,
  userSetStats: schema.userSetStats,
  appSettings: schema.appSettings,
  auditLog: schema.auditLog,
  aiGenerationJobs: schema.aiGenerationJobs,
  aiCandidates: schema.aiCandidates,
  questionEmbeddings: schema.questionEmbeddings,
  duplicateFlags: schema.duplicateFlags,
};

export type BackupPayload = {
  format: "qms-backup";
  version: 1;
  createdAt: number;
  tables: Record<TableName, Record<string, unknown>[]>;
};

const CHUNK_ROWS = 4;

export type BackupDb = DrizzleD1Database<typeof schema>;

async function wipe(database: BackupDb): Promise<void> {
  // FK enforcement off during the wipe so children can go without parent order
  // (same trick the 0002 migration uses).
  await database.run(sql`PRAGMA foreign_keys = OFF`);
  try {
    for (const name of [...TABLE_ORDER].reverse()) {
      await database.delete(TABLES[name]);
    }
  } finally {
    await database.run(sql`PRAGMA foreign_keys = ON`);
  }
}

/** Dump every table into a serialisable payload. */
export async function exportDatabase(database: BackupDb): Promise<BackupPayload> {
  const tables = {} as BackupPayload["tables"];
  for (const name of TABLE_ORDER) {
    const rows = await database.select().from(TABLES[name] as never);
    tables[name] = rows as unknown as Record<string, unknown>[];
  }
  return { format: "qms-backup", version: 1, createdAt: Date.now(), tables };
}

/**
 * Wipe and restore. Precondition: the payload is a `qms-backup` (checked).
 * Multi-row inserts are chunked so a single statement never exceeds D1's
 * ~100 bound-parameter ceiling (PLAN.md §0.1).
 */
export async function importDatabase(
  database: BackupDb,
  payload: BackupPayload,
): Promise<{ restored: Record<string, number> }> {
  if (payload.format !== "qms-backup" || payload.version !== 1) {
    throw new Error("Not a Quiz Master Supreme backup payload.");
  }

  await wipe(database);
  const restored: Record<string, number> = {};

  for (const name of TABLE_ORDER) {
    const rows = payload.tables[name] ?? [];
    for (let i = 0; i < rows.length; i += CHUNK_ROWS) {
      await database
        .insert(TABLES[name] as never)
        .values(rows.slice(i, i + CHUNK_ROWS) as never);
    }
    restored[name] = rows.length;
  }

  return { restored };
}

/**
 * Export the current database and import it right back — a dry rehearsal
 * in place. Kept as a one-liner so the scripts and the exit test use
 * exactly the same code path as a real restore.
 */
export async function rehearseRestore(
  database: BackupDb,
): Promise<{ restored: Record<string, number> }> {
  const payload = await exportDatabase(database);
  return importDatabase(database, payload);
}