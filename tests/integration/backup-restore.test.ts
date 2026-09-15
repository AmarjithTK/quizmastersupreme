/**
 * Backup & restore rehearsal (M14 exit test).
 *
 * The claim "a restore from backup has been performed successfully at least
 * once" is hard to believe on trust. This test DOES it: seed real rows, export,
 * wipe, import back, and verify every object survived byte-for-byte — including
 * that FTS5 search still works after the restore (the virtual table is
 * trigger-maintained and must rebuild itself).
 */

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { getPlatformProxy } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, setDbForTests } from "@/db/client";
import * as schema from "@/db/schema";
import { exportDatabase, importDatabase, TABLE_ORDER } from "@/modules/backup";
import { createQuestion, type QuestionDraft } from "@/modules/questions";
import { listQuestionsForAdmin } from "@/modules/questions";

const ACTOR = "user__backup_test";
const TOPIC = "BackupRestoreTest";
const JOB_ID = "job__backup_planner";
const SEGMENT_ID = "segment__backup_planner";
const FACT_ID = "fact__backup_planner";
const BATCH_ID = "batch__backup_planner";
const REJECTION_ID = "rejection__backup_planner";

let proxy: { env: { DB: D1Database }; dispose: () => Promise<void> } | null = null;

const draft: QuestionDraft = {
  stem: "Which planet orbits closest to the Sun in this backup test?",
  options: [
    { key: "A", body: "Mercury" },
    { key: "B", body: "Venus" },
    { key: "C", body: "Earth" },
    { key: "D", body: "Mars" },
  ],
  correctOptionKey: "A",
  explanation: "Mercury is the innermost planet.",
  backstory:
    "A sufficiently long backstory for the backup-restore rehearsal, written as prose so the validator accepts it.",
  difficulty: "easy",
  topic: TOPIC,
  tags: ["backup-test"],
};

beforeAll(async () => {
  proxy = await getPlatformProxy<{ DB: D1Database }>({
    configPath: "wrangler.jsonc",
    persist: { path: ".tooling/test-state" },
  });
  setDbForTests(drizzle(proxy.env.DB, { schema }));
  await db().delete(schema.questions).where(eq(schema.questions.topic, TOPIC));
  await db().delete(schema.aiGenerationJobs).where(eq(schema.aiGenerationJobs.id, JOB_ID));
  await createQuestion(draft, ACTOR, { status: "active" });
  const now = Date.now();
  await db().insert(schema.aiGenerationJobs).values({
    id: JOB_ID, createdBy: ACTOR, brief: "Verify planner backup", topic: TOPIC,
    requestedCount: 1, model: "fixture/model", promptVersion: "fixture",
    planRevision: 1, phase: "reviewable", blueprintJson: '{"fixture":true}',
    blueprintHash: "fixture-hash", status: "partial", createdAt: now,
  });
  await db().insert(schema.aiGenerationSegments).values({
    id: SEGMENT_ID, jobId: JOB_ID, planRevision: 1, key: "coverage",
    label: "Coverage", intent: "Verify backup", targetCount: 1,
    policyJson: "{}", sourceQueriesJson: "[]", sourceRequirementsJson: "[]",
    createdAt: now, updatedAt: now,
  });
  await db().insert(schema.aiSourceFacts).values({
    id: FACT_ID, jobId: JOB_ID, segmentId: SEGMENT_ID,
    claim: "Fixture claim", sourceUrl: "https://example.org/fixture",
    sourceTitle: "Fixture reference", retrievedAt: now,
  });
  await db().insert(schema.aiGenerationBatches).values({
    id: BATCH_ID, jobId: JOB_ID, batchNo: 1, asked: 1, status: "failed",
    directiveJson: '{"fixture":true}', directiveHash: "directive-hash",
    planRevision: 1, requestManifestKey: "ai-jobs/fixture/request.json",
    startedAt: now,
  });
  await db().insert(schema.aiGenerationRejections).values({
    id: REJECTION_ID, jobId: JOB_ID, batchId: BATCH_ID, batchNo: 1,
    modelIndex: 0, stage: "schema", code: "SCHEMA_INVALID",
    reasonsJson: '["fixture invalid"]', rawJson: '{"fixture":true}',
    createdAt: now,
  });
});

afterAll(async () => {
  await db().delete(schema.questions).where(eq(schema.questions.topic, TOPIC));
  await db().delete(schema.aiGenerationJobs).where(eq(schema.aiGenerationJobs.id, JOB_ID));
  await proxy?.dispose();
  proxy = null;
  setDbForTests(null);
});

describe("backup → restore rehearsal", () => {
  it("round-trips every table and keeps FTS5 search working", async () => {
    // Prove FTS search finds the seeded question BEFORE the wipe.
    const before = await listQuestionsForAdmin({ q: "Mercury" });
    expect(before.rows.length).toBeGreaterThan(0);

    const payload = await exportDatabase(db());
    expect(payload.format).toBe("qms-backup");

    const beforeCount = Object.values(payload.tables).reduce((n, rows) => n + rows.length, 0);
    expect(beforeCount).toBeGreaterThan(0);

    // The destructive rehearsal: wipe and restore from the payload.
    const { restored } = await importDatabase(db(), payload);
    for (const name of TABLE_ORDER) {
      expect(restored[name]).toBe(payload.tables[name].length);
    }

    expect(payload.tables.aiGenerationSegments).toContainEqual(expect.objectContaining({ id: SEGMENT_ID }));
    expect(payload.tables.aiSourceFacts).toContainEqual(expect.objectContaining({ id: FACT_ID }));
    expect(payload.tables.aiGenerationRejections).toContainEqual(expect.objectContaining({ id: REJECTION_ID }));
    expect((await db().select().from(schema.aiGenerationJobs).where(eq(schema.aiGenerationJobs.id, JOB_ID)))[0])
      .toEqual(expect.objectContaining({ blueprintHash: "fixture-hash", planRevision: 1 }));
    expect((await db().select().from(schema.aiGenerationBatches).where(eq(schema.aiGenerationBatches.id, BATCH_ID)))[0])
      .toEqual(expect.objectContaining({ directiveHash: "directive-hash" }));

    // Byte-for-byte equality of what we care about — the question bank.
    const questionsAfter = await db()
      .select()
      .from(schema.questions)
      .where(eq(schema.questions.topic, TOPIC));
    expect(questionsAfter).toHaveLength(1);
    expect(questionsAfter[0]!.stem).toBe(draft.stem);

    const optionsAfter = await db()
      .select({ body: schema.questionOptions.body })
      .from(schema.questionOptions)
      .where(eq(schema.questionOptions.questionId, questionsAfter[0]!.id));
    expect(optionsAfter.map((o) => o.body)).toContain("Mercury");

    // FTS5 must rebuild from the triggers — search still works after restore.
    const after = await listQuestionsForAdmin({ q: "Mercury" });
    expect(after.rows.length).toBeGreaterThan(0);
  });

  it("refuses a payload that is not a qms-backup", async () => {
    await expect(
      importDatabase(db(), { format: "qms-backup", version: 999, createdAt: 0, tables: {} } as never),
    ).rejects.toThrow("Not a Quiz Master Supreme backup");
  });
});
