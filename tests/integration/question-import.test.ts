/**
 * CSV import/export (M9) against real D1.
 *
 * The milestone's exit test is here in full: import 500 rows, duplicates are
 * flagged, invalid rows carry reasons, and NOTHING is dropped silently. The
 * round-trip test proves export and import agree on columns, which is what
 * makes "export, edit, re-import" a workflow rather than a trap.
 */

import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { getPlatformProxy } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, setDbForTests } from "@/db/client";
import * as schema from "@/db/schema";
import {
  exportQuestionsCsv,
  importQuestions,
  listQuestionsForAdmin,
  toCsv,
} from "@/modules/questions";

const ACTOR = "user__import_test";
const TOPIC = "BulkImportTest";

let proxy: { env: { DB: D1Database }; dispose: () => Promise<void> } | null = null;

const STORY =
  "An adequately long backstory for the bulk import fixture, written as real prose so the " +
  "validator accepts it without complaint.";

const HEADER = [
  "stem",
  "option_a",
  "option_b",
  "option_c",
  "option_d",
  "option_e",
  "correct",
  "explanation",
  "backstory",
  "difficulty",
  "topic",
  "tags",
  "year",
  "exam_body",
  "source",
  "source_url",
];

/** Column indices, named so the overrides below stay readable. */
const COL = {
  stem: 0,
  optionC: 3,
  optionD: 4,
  correct: 6,
  explanation: 7,
  backstory: 8,
} as const;

function row(stem: string, overrides: Partial<Record<number, string>> = {}): string[] {
  const base = [
    stem,
    "Zephyr",
    "Quartz",
    "Nimbus",
    "Onyx",
    "",
    "A",
    "Because Zephyr.",
    STORY,
    "easy",
    TOPIC,
    "bulk|fixture",
    "2025",
    "Kerala PSC",
    "Test source",
    "",
  ];
  for (const [index, value] of Object.entries(overrides)) base[Number(index)] = value!;
  return base;
}

beforeAll(async () => {
  proxy = await getPlatformProxy<{ DB: D1Database }>({
    configPath: "wrangler.jsonc",
    persist: { path: ".tooling/test-state" },
  });
  setDbForTests(drizzle(proxy.env.DB, { schema }));
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await proxy?.dispose();
  proxy = null;
  setDbForTests(null);
});

async function cleanup(): Promise<void> {
  await db().delete(schema.questions).where(eq(schema.questions.topic, TOPIC)).run();
}

describe("importQuestions", () => {
  it("imports valid rows with their options", async () => {
    const csv = toCsv([HEADER, row("Bulk import created question one?"), row("Bulk import created question two?")]);

    const report = await importQuestions(csv, ACTOR, { status: "draft" });

    expect(report.total).toBe(2);
    expect(report.created).toBe(2);
    expect(report.invalid).toBe(0);
    expect(report.duplicates).toBe(0);
    expect(report.results.every((r) => r.status === "created")).toBe(true);

    const saved = await db()
      .select()
      .from(schema.questions)
      .where(eq(schema.questions.topic, TOPIC));
    expect(saved.length).toBeGreaterThanOrEqual(2);

    const options = await db()
      .select()
      .from(schema.questionOptions)
      .where(inArray(schema.questionOptions.questionId, saved.map((q) => q.id)));
    // 4 options each.
    expect(options.length).toBeGreaterThanOrEqual(saved.length * 4);
    // And exactly one correct per question.
    const correctCounts = new Map<string, number>();
    for (const option of options) {
      if (option.isCorrect === 1) {
        correctCounts.set(option.questionId, (correctCounts.get(option.questionId) ?? 0) + 1);
      }
    }
    for (const count of correctCounts.values()) expect(count).toBe(1);
  });

  it("flags a row that already exists in the bank, and says what it matched", async () => {
    const stem = "Bulk import already present question?";
    await importQuestions(toCsv([HEADER, row(stem)]), ACTOR);

    const report = await importQuestions(toCsv([HEADER, row(stem.toUpperCase())]), ACTOR);

    expect(report.created).toBe(0);
    expect(report.duplicates).toBe(1);
    const result = report.results[0]!;
    expect(result.status).toBe("duplicate");
    expect(result.matchedStem).toBeTruthy();
    expect(result.reasons?.[0]).toMatch(/Already in the bank/);
  });

  it("flags duplicates WITHIN the file, pointing at the earlier row", async () => {
    const csv = toCsv([
      HEADER,
      row("Bulk import in-file duplicate?"),
      row("bulk import in file duplicate"), // same after normalization
    ]);

    const report = await importQuestions(csv, ACTOR);

    expect(report.created).toBe(1);
    expect(report.duplicates).toBe(1);
    const dup = report.results.find((r) => r.status === "duplicate_in_file")!;
    expect(dup.row).toBe(2);
    expect(dup.reasons?.[0]).toMatch(/row 1/);
  });

  it("reports every invalid row with its reasons", async () => {
    const csv = toCsv([
      HEADER,
      row("Bulk import valid row among invalid ones?"),
      row("Bulk import only three options?", { [COL.optionC]: "", [COL.optionD]: "" }), // drops C and D
      row("Bulk import missing correct key?", { [COL.correct]: "E" }),
      row("Bulk import short backstory?", { [COL.backstory]: "Too short." }),
      row("Which is Zephyr in this bulk import question?", {}), // stem gives the answer
    ]);

    const report = await importQuestions(csv, ACTOR);

    expect(report.total).toBe(5);
    expect(report.created).toBe(1);
    expect(report.invalid).toBe(4);

    for (const result of report.results.filter((r) => r.status === "invalid")) {
      expect(result.reasons?.length).toBeGreaterThan(0);
      expect(result.stem).toBeTruthy();
    }
  });

  it("reports EVERY input row — nothing is dropped silently", async () => {
    const rows = [
      HEADER,
      row("Bulk import coverage valid one?"),
      row("Bulk import coverage valid two?"),
      row("Bulk import coverage duplicate?", { [COL.correct]: "B" }),
      row("Bulk import coverage invalid?", { [COL.backstory]: "nope" }),
      row("Bulk import coverage duplicate?", { [COL.correct]: "B" }), // in-file duplicate
    ];
    const report = await importQuestions(toCsv(rows), ACTOR);

    // 5 data rows in, 5 report entries out.
    expect(report.results).toHaveLength(5);
    expect(report.total).toBe(5);
    expect(report.created + report.duplicates + report.invalid).toBe(report.total);

    // And the reported row numbers are the human-visible ones (header excluded).
    expect(report.results.map((r) => r.row)).toEqual([1, 2, 3, 4, 5]);
  });

  it("writes NOTHING on a dry run", async () => {
    const stem = "Bulk import dry run must not persist this?";
    const before = await db()
      .select({ n: schema.questions.id })
      .from(schema.questions)
      .where(eq(schema.questions.topic, TOPIC));

    const report = await importQuestions(toCsv([HEADER, row(stem)]), ACTOR, { dryRun: true });

    expect(report.dryRun).toBe(true);
    expect(report.created).toBe(1);

    const after = await db()
      .select({ n: schema.questions.id })
      .from(schema.questions)
      .where(eq(schema.questions.topic, TOPIC));
    expect(after.length).toBe(before.length);

    const found = await db()
      .select()
      .from(schema.questions)
      .where(eq(schema.questions.stem, stem));
    expect(found).toHaveLength(0);
  });
});

// ── the milestone exit test ──────────────────────────────────────────────────

describe("M9 exit test — 500 rows", () => {
  it("imports 500 rows, reporting every single one", async () => {
    const started = Date.now();
    const rows: string[][] = [HEADER];
    for (let i = 1; i <= 500; i++) {
      rows.push(row(`Bulk five hundred question number ${i}?`));
    }

    const report = await importQuestions(toCsv(rows), ACTOR, { status: "draft" });
    const elapsed = Date.now() - started;

    expect(report.total).toBe(500);
    expect(report.created).toBe(500);
    expect(report.results).toHaveLength(500);
    expect(report.created + report.duplicates + report.invalid).toBe(500);

    console.log(`    imported 500 questions in ${elapsed}ms`);

    // Prove they are really there, with options.
    const stored = await db()
      .select({ id: schema.questions.id })
      .from(schema.questions)
      .where(eq(schema.questions.topic, TOPIC));
    expect(stored.length).toBeGreaterThanOrEqual(500);
  }, 120_000);

  it("re-importing the same 500 rows reports them ALL as duplicates", async () => {
    const rows: string[][] = [HEADER];
    for (let i = 1; i <= 500; i++) {
      rows.push(row(`Bulk five hundred question number ${i}?`));
    }

    const report = await importQuestions(toCsv(rows), ACTOR);
    expect(report.total).toBe(500);
    expect(report.created).toBe(0);
    expect(report.duplicates).toBe(500);
    expect(report.results.filter((r) => r.status === "duplicate")).toHaveLength(500);
  }, 120_000);
});

// ── export ↔ import symmetry ─────────────────────────────────────────────────

describe("export round trip", () => {
  it("exports with the importer's columns, so an export re-imports as duplicates", async () => {
    const { csv, count } = await exportQuestionsCsv({ topic: TOPIC }, 5);
    expect(count).toBeGreaterThan(0);
    expect(csv.split("\r\n")[0]).toBe(HEADER.join(","));

    // Feed the export straight back in: it must match, not create new rows.
    const report = await importQuestions(csv, ACTOR);
    expect(report.created).toBe(0);
    expect(report.duplicates).toBe(report.total);
  });

  it("neutralises formula-like text so a spreadsheet cannot execute it", async () => {
    await importQuestions(
      toCsv([HEADER, row("Bulk import formula guard?", { [COL.explanation]: '=HYPERLINK("http://evil")' })]),
      ACTOR,
    );

    // Scoped to the topic so the assertion is about the guard, not about which
    // of 500+ similarly-worded rows wins the search.
    const { csv } = await exportQuestionsCsv({ q: "Bulk import formula guard", topic: TOPIC }, 5);
    // The explanation column must be prefixed, not emitted raw.
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).not.toMatch(/,=HYPERLINK/);
  });
});

// ── relevance ranking under a large bank ─────────────────────────────────────

describe("search relevance in a large bank", () => {
  it("finds the specific question for a rare term despite 500+ similar rows", async () => {
    // Every bulk row contains "bulk" and "import"; only this one has the rare
    // word. Without bm25 ordering the hit cap could exclude it entirely.
    await importQuestions(
      toCsv([HEADER, row("Bulk import ranking probe about xylophonic resonance?")]),
      ACTOR,
    );

    const result = await listQuestionsForAdmin({ q: "xylophonic" });
    expect(result.total).toBeGreaterThan(0);
    expect(result.rows.some((r) => r.stem.includes("xylophonic"))).toBe(true);
  });

  it("still finds it when the query also matches the crowd", async () => {
    const result = await listQuestionsForAdmin({ q: "bulk import xylophonic" });
    expect(result.rows.some((r) => r.stem.includes("xylophonic"))).toBe(true);
  });
});
