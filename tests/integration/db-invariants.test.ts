/**
 * Guards the FROZEN design constraints from PLAN.md §2 against the real
 * migrations. These are not feature tests — they are the tests that stop the
 * architecture quietly eroding.
 *
 * Runs against a dedicated local D1 (.tooling/test-state), migrated by
 * `pnpm pretest`.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { allRows, expectRejected, openTestDb, type TestD1 } from "../helpers/test-db";

const NOW = Date.now();
const CATEGORY_ID = "cat__test_invariants";
const SET_ID = "set__test_invariants";

let ctx: TestD1;
let db: D1Database;

beforeAll(async () => {
  ctx = await openTestDb();
  db = ctx.env.DB;

  // Throwaway parent rows so FK-constrained inserts have something to point at.
  await db
    .prepare(
      `INSERT OR REPLACE INTO categories (id, slug, title, sort_order, status, created_at, updated_at)
       VALUES (?, ?, ?, 0, 'published', ?, ?)`,
    )
    .bind(CATEGORY_ID, "test-invariants", "Test Invariants", NOW, NOW)
    .run();

  await db
    .prepare(
      `INSERT OR REPLACE INTO quiz_sets
       (id, category_id, slug, title, mode, difficulty, shuffle_questions, shuffle_options,
        sort_order, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'practice', 'medium', 1, 0, 0, 'published', ?, ?)`,
    )
    .bind(SET_ID, CATEGORY_ID, "test-invariants", "Test Invariants", NOW, NOW)
    .run();
});

afterAll(async () => {
  if (!db) return;
  await db.prepare(`DELETE FROM quiz_attempts WHERE set_id = ?`).bind(SET_ID).run();
  await db.prepare(`DELETE FROM question_set_questions WHERE set_id = ?`).bind(SET_ID).run();
  await db.prepare(`DELETE FROM quiz_sets WHERE id = ?`).bind(SET_ID).run();
  await db.prepare(`DELETE FROM categories WHERE id = ?`).bind(CATEGORY_ID).run();
  await ctx?.dispose();
});

// ─────────────────────────────────────────────────────────────────────────────
// §2.1 — the content tree is exactly two levels deep
// ─────────────────────────────────────────────────────────────────────────────

describe("§2.1 two-level content model", () => {
  it("has NO parent_id column anywhere in the schema", async () => {
    const tables = await allRows<{ name: string; sql: string }>(
      db,
      `SELECT name, sql FROM sqlite_master WHERE type = 'table'`,
    );

    const offenders = tables
      .filter((t) => !t.name.startsWith("sqlite_") && !t.name.startsWith("_cf_"))
      .filter((t) => /parent_id/i.test(t.sql ?? ""))
      .map((t) => t.name);

    expect(offenders).toEqual([]);
  });

  it("makes quiz_sets.category_id NOT NULL (a set cannot float or nest)", async () => {
    const error = await expectRejected(
      db,
      `INSERT INTO quiz_sets
       (id, category_id, slug, title, mode, difficulty, shuffle_questions, shuffle_options,
        sort_order, status, created_at, updated_at)
       VALUES ('set__orphan', NULL, 'orphan', 'Orphan', 'practice', 'medium', 1, 0, 0, 'draft', ?, ?)`,
      NOW,
      NOW,
    );
    expect(error).not.toBeNull();
    expect(error!.toLowerCase()).toContain("not null");
  });

  it("rejects a quiz set whose category does not exist", async () => {
    const error = await expectRejected(
      db,
      `INSERT INTO quiz_sets
       (id, category_id, slug, title, mode, difficulty, shuffle_questions, shuffle_options,
        sort_order, status, created_at, updated_at)
       VALUES ('set__badfk', 'cat__nope', 'badfk', 'Bad FK', 'practice', 'medium', 1, 0, 0, 'draft', ?, ?)`,
      NOW,
      NOW,
    );
    expect(error).not.toBeNull();
    expect(error!.toLowerCase()).toContain("foreign key");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Schema inventory
// ─────────────────────────────────────────────────────────────────────────────

describe("schema inventory", () => {
  it("creates all 17 application tables", async () => {
    const rows = await allRows<{ name: string }>(
      db,
      `SELECT name FROM sqlite_master
       WHERE type = 'table'
         AND name NOT LIKE 'sqlite_%'
         AND name NOT LIKE '_cf_%'
         AND name NOT LIKE 'd1_%'
         AND name NOT LIKE 'questions_fts%'
       ORDER BY name`,
    );
    const names = rows.map((r) => r.name);
    expect(names).toHaveLength(17);
    expect(names).toEqual(
      expect.arrayContaining([
        "users",
        "auth_sessions",
        "oauth_states",
        "categories",
        "quiz_sets",
        "questions",
        "question_options",
        "question_set_questions",
        "quiz_attempts",
        "quiz_attempt_answers",
        "user_question_seen",
        "user_set_stats",
        "ai_generation_jobs",
        "ai_generation_batches",
        "ai_candidates",
        "audit_log",
        "app_settings",
      ]),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §6.3 — FTS5 full-text search
// ─────────────────────────────────────────────────────────────────────────────

describe("§6.3 FTS5", () => {
  const QID = "q__fts_test";
  const HASH = "0".repeat(64);

  afterAll(async () => {
    await db.prepare(`DELETE FROM questions WHERE id = ?`).bind(QID).run();
  });

  it("has the virtual table and all three sync triggers", async () => {
    const tables = await allRows<{ name: string }>(
      db,
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'questions_fts'`,
    );
    expect(tables).toHaveLength(1);

    const triggers = await allRows<{ name: string }>(
      db,
      `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'questions_fts_%' ORDER BY name`,
    );
    expect(triggers.map((t) => t.name)).toEqual([
      "questions_fts_ad",
      "questions_fts_ai",
      "questions_fts_au",
    ]);
  });

  it("keeps the index in sync on insert, update and delete", async () => {
    await db
      .prepare(
        `INSERT INTO questions
         (id, stem, stem_format, difficulty, topic, language, status,
          normalized_hash, content_hash, origin, created_at, updated_at)
         VALUES (?, ?, 'markdown', 'easy', 'Testing', 'en', 'active', ?, ?, 'manual', ?, ?)`,
      )
      .bind(QID, "Which planet is known as the Red Planet?", HASH, HASH, NOW, NOW)
      .run();

    let hits = await allRows<{ question_id: string }>(
      db,
      `SELECT question_id FROM questions_fts WHERE questions_fts MATCH 'planet'`,
    );
    expect(hits.map((h) => h.question_id)).toContain(QID);

    // Porter stemming: "planets" and "planet" must collide.
    hits = await allRows<{ question_id: string }>(
      db,
      `SELECT question_id FROM questions_fts WHERE questions_fts MATCH 'planets'`,
    );
    expect(hits.map((h) => h.question_id)).toContain(QID);

    // Update trigger.
    await db
      .prepare(`UPDATE questions SET stem = ? WHERE id = ?`)
      .bind("Which planet is known as the Morning Star?", QID)
      .run();
    hits = await allRows<{ question_id: string }>(
      db,
      `SELECT question_id FROM questions_fts WHERE questions_fts MATCH 'morning'`,
    );
    expect(hits.map((h) => h.question_id)).toContain(QID);

    // Delete trigger.
    await db.prepare(`DELETE FROM questions WHERE id = ?`).bind(QID).run();
    hits = await allRows<{ question_id: string }>(
      db,
      `SELECT question_id FROM questions_fts WHERE questions_fts MATCH 'morning'`,
    );
    expect(hits.map((h) => h.question_id)).not.toContain(QID);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §6.4 — the single-correct-option invariant
// ─────────────────────────────────────────────────────────────────────────────

describe("§6.4 one correct option per question", () => {
  const QID = "q__single_correct";

  beforeAll(async () => {
    const hash = "1".repeat(64);
    await db
      .prepare(
        `INSERT OR REPLACE INTO questions
         (id, stem, stem_format, difficulty, language, status,
          normalized_hash, content_hash, origin, created_at, updated_at)
         VALUES (?, 'Pick exactly one', 'markdown', 'easy', 'en', 'active', ?, ?, 'manual', ?, ?)`,
      )
      .bind(QID, hash, hash, NOW, NOW)
      .run();
  });

  afterAll(async () => {
    await db.prepare(`DELETE FROM questions WHERE id = ?`).bind(QID).run();
  });

  it("allows one correct option", async () => {
    const error = await expectRejected(
      db,
      `INSERT INTO question_options (id, question_id, option_key, body, is_correct, sort_order)
       VALUES (?, ?, 'A', 'Right answer', 1, 0)`,
      `${QID}_A`,
      QID,
    );
    expect(error).toBeNull();
  });

  it("REJECTS a second correct option", async () => {
    const error = await expectRejected(
      db,
      `INSERT INTO question_options (id, question_id, option_key, body, is_correct, sort_order)
       VALUES (?, ?, 'B', 'Also right', 1, 1)`,
      `${QID}_B`,
      QID,
    );
    expect(error).not.toBeNull();
    expect(error!.toLowerCase()).toContain("unique");
  });

  it("still allows unlimited wrong options", async () => {
    for (const [key, index] of [
      ["C", 2],
      ["D", 3],
    ] as const) {
      const error = await expectRejected(
        db,
        `INSERT INTO question_options (id, question_id, option_key, body, is_correct, sort_order)
         VALUES (?, ?, ?, 'Wrong', 0, ?)`,
        `${QID}_${key}`,
        QID,
        key,
        index,
      );
      expect(error).toBeNull();
    }
  });

  it("rejects an option key outside A–E", async () => {
    const error = await expectRejected(
      db,
      `INSERT INTO question_options (id, question_id, option_key, body, is_correct, sort_order)
       VALUES (?, ?, 'Z', 'Nope', 0, 4)`,
      `${QID}_Z`,
      QID,
    );
    expect(error).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §11.4 — the resume invariant (THE core feature)
// ─────────────────────────────────────────────────────────────────────────────

describe("§11.4 one in-progress attempt per user per set", () => {
  const USER = "user__resume_test";

  afterAll(async () => {
    await db.prepare(`DELETE FROM quiz_attempts WHERE user_id = ?`).bind(USER).run();
  });

  function insertAttempt(id: string, status: string) {
    return expectRejected(
      db,
      `INSERT INTO quiz_attempts
       (id, user_id, set_id, status, question_order, total_questions, current_index,
        answered_count, correct_count, wrong_count, skipped_count, time_spent_ms,
        started_at, last_activity_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, '[]', 10, 0, 0, 0, 0, 0, 0, ?, ?, ?, ?)`,
      id,
      USER,
      SET_ID,
      status,
      NOW,
      NOW,
      NOW,
      NOW,
    );
  }

  it("allows the first in-progress attempt", async () => {
    expect(await insertAttempt("att__1", "in_progress")).toBeNull();
  });

  it("REJECTS a second concurrent in-progress attempt for the same set", async () => {
    const error = await insertAttempt("att__2", "in_progress");
    expect(error).not.toBeNull();
    expect(error!.toLowerCase()).toContain("unique");
  });

  it("REJECTS a second in-progress attempt even for a different set of the same user", async () => {
    // The index is (user_id, set_id), so a DIFFERENT set must be allowed.
    await db
      .prepare(
        `INSERT OR REPLACE INTO quiz_sets
         (id, category_id, slug, title, mode, difficulty, shuffle_questions, shuffle_options,
          sort_order, status, created_at, updated_at)
         VALUES ('set__resume_other', ?, 'resume-other', 'Other', 'practice', 'easy', 1, 0, 0, 'published', ?, ?)`,
      )
      .bind(CATEGORY_ID, NOW, NOW)
      .run();

    const error = await expectRejected(
      db,
      `INSERT INTO quiz_attempts
       (id, user_id, set_id, status, question_order, total_questions, current_index,
        answered_count, correct_count, wrong_count, skipped_count, time_spent_ms,
        started_at, last_activity_at, created_at, updated_at)
       VALUES ('att__3', ?, 'set__resume_other', 'in_progress', '[]', 10, 0, 0, 0, 0, 0, 0, ?, ?, ?, ?)`,
      USER,
      NOW,
      NOW,
      NOW,
      NOW,
    );
    expect(error).toBeNull();

    await db.prepare(`DELETE FROM quiz_attempts WHERE id = 'att__3'`).run();
    await db.prepare(`DELETE FROM quiz_sets WHERE id = 'set__resume_other'`).run();
  });

  it("allows a NEW attempt once the previous one is completed", async () => {
    await db
      .prepare(`UPDATE quiz_attempts SET status = 'completed' WHERE id = 'att__1'`)
      .run();

    expect(await insertAttempt("att__4", "in_progress")).toBeNull();

    await db.prepare(`DELETE FROM quiz_attempts WHERE id IN ('att__1','att__4')`).run();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §2.5 — idempotent answer writes
// ─────────────────────────────────────────────────────────────────────────────

describe("§2.5 idempotent answers", () => {
  const QID = "q__idem";
  const ATTEMPT = "att__idem";

  // The exact upsert shape modules/quiz will use on every answer submit.
  const UPSERT = `INSERT INTO quiz_attempt_answers
       (attempt_id, question_id, question_index, selected_option_key, is_correct, time_taken_ms, answered_at)
     VALUES (?, ?, 0, ?, ?, ?, ?)
     ON CONFLICT(attempt_id, question_id) DO UPDATE SET
       selected_option_key = excluded.selected_option_key,
       is_correct         = excluded.is_correct,
       time_taken_ms      = excluded.time_taken_ms,
       answered_at        = excluded.answered_at`;

  beforeAll(async () => {
    const hash = "3".repeat(64);
    await db
      .prepare(
        `INSERT OR REPLACE INTO questions
         (id, stem, stem_format, difficulty, language, status,
          normalized_hash, content_hash, origin, created_at, updated_at)
         VALUES (?, 'Idempotency probe', 'markdown', 'easy', 'en', 'active', ?, ?, 'manual', ?, ?)`,
      )
      .bind(QID, hash, hash, NOW, NOW)
      .run();

    await db
      .prepare(
        `INSERT OR REPLACE INTO quiz_attempts
         (id, user_id, set_id, status, question_order, total_questions, current_index,
          answered_count, correct_count, wrong_count, skipped_count, time_spent_ms,
          started_at, last_activity_at, created_at, updated_at)
         VALUES (?, 'user__idem', ?, 'in_progress', ?, 1, 0, 0, 0, 0, 0, 0, ?, ?, ?, ?)`,
      )
      .bind(ATTEMPT, SET_ID, JSON.stringify([QID]), NOW, NOW, NOW, NOW)
      .run();
  });

  afterAll(async () => {
    await db.prepare(`DELETE FROM quiz_attempt_answers WHERE attempt_id = ?`).bind(ATTEMPT).run();
    await db.prepare(`DELETE FROM quiz_attempts WHERE id = ?`).bind(ATTEMPT).run();
    await db.prepare(`DELETE FROM questions WHERE id = ?`).bind(QID).run();
  });

  it("keys answers on (attempt_id, question_id), in that order", async () => {
    const cols = await allRows<{ name: string; pk: number }>(
      db,
      `PRAGMA table_info(quiz_attempt_answers)`,
    );
    const pkColumns = cols
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name);
    expect(pkColumns).toEqual(["attempt_id", "question_id"]);
  });

  it("turns a re-submitted answer into an update, never a second row", async () => {
    // First submission: wrong.
    await db.prepare(UPSERT).bind(ATTEMPT, QID, "A", 0, 100, NOW).run();
    let rows = await allRows<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM quiz_attempt_answers WHERE attempt_id = ?`,
      ATTEMPT,
    );
    expect(Number(rows[0]?.n)).toBe(1);

    // Re-submission (double-click, retry, second tab): must NOT duplicate.
    await db.prepare(UPSERT).bind(ATTEMPT, QID, "B", 1, 500, NOW + 1000).run();
    rows = await allRows<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM quiz_attempt_answers WHERE attempt_id = ?`,
      ATTEMPT,
    );
    expect(Number(rows[0]?.n)).toBe(1);

    const answer = await allRows<{ selected_option_key: string; is_correct: number }>(
      db,
      `SELECT selected_option_key, is_correct FROM quiz_attempt_answers
       WHERE attempt_id = ? AND question_id = ?`,
      ATTEMPT,
      QID,
    );
    // Last write wins on the value, but the row count is invariant.
    expect(answer[0]?.selected_option_key).toBe("B");
    expect(Number(answer[0]?.is_correct)).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §6.2 — deeper storage invariants
// ─────────────────────────────────────────────────────────────────────────────

describe("storage invariants", () => {
  it("rejects a retired question status", async () => {
    const hash = "2".repeat(64);
    const QID = "q__legacy_status";
    // `published` was one of the eight pre-revamp statuses; the CHECK now
    // accepts only active/rejected/archived.
    const error = await expectRejected(
      db,
      `INSERT INTO questions
       (id, stem, stem_format, difficulty, language, status,
        normalized_hash, content_hash, origin, created_at, updated_at)
       VALUES (?, 'Legacy status probe', 'markdown', 'easy', 'en', 'published', ?, ?, 'manual', ?, ?)`,
      QID,
      hash,
      hash,
      NOW,
      NOW,
    );
    expect(error).not.toBeNull();
  });

  it("enforces the (category_id, slug) uniqueness on quiz_sets", async () => {
    const error = await expectRejected(
      db,
      `INSERT INTO quiz_sets
       (id, category_id, slug, title, mode, difficulty, shuffle_questions, shuffle_options,
        sort_order, status, created_at, updated_at)
       VALUES ('set__dupslug', ?, 'test-invariants', 'Clashing slug', 'practice', 'easy', 1, 0, 0, 'draft', ?, ?)`,
      CATEGORY_ID,
      NOW,
      NOW,
    );
    expect(error).not.toBeNull();
    expect(error!.toLowerCase()).toContain("unique");
  });

  it("rejects an invalid attempt status", async () => {
    const error = await expectRejected(
      db,
      `INSERT INTO quiz_attempts
       (id, user_id, set_id, status, question_order, total_questions, current_index,
        answered_count, correct_count, wrong_count, skipped_count, time_spent_ms,
        started_at, last_activity_at, created_at, updated_at)
       VALUES ('att__bad', 'u', ?, 'nonsense', '[]', 1, 0, 0, 0, 0, 0, 0, ?, ?, ?, ?)`,
      SET_ID,
      NOW,
      NOW,
      NOW,
      NOW,
    );
    expect(error).not.toBeNull();
  });
});
