/**
 * Coverage-aware generation (M13). PLAN.md §12.4.
 *
 * The problem this solves: an LLM call is stateless, so it has no idea that the
 * bank already contains 400 questions on the topic it is about to write about.
 * Sending all 400 is impossible (and long contexts degrade quality anyway), so
 * the existing coverage is COMPRESSED into a budgeted list of covered concepts.
 *
 *   stage A  retrieve the most relevant existing questions (exact topic tag
 *            first; bm25-ranked FTS5 only as a top-up)
 *   stage B  extract a short concept key from each — stem plus its answer
 *   stage C  fit the result into a token budget
 *
 * Stage C is deterministic by default. An optional model-assisted compression
 * pass exists for when the concept list overflows badly, but a stale or failed
 * compression must never block generation, so the deterministic path is the one
 * that always runs.
 */

import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { logInfo } from "@/lib/logger";
import { buildFtsMatch, normalizeStem } from "@/modules/questions";

/** Rough token estimate. Good enough for budgeting; not a tokenizer. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const INTERROGATIVE_PREFIXES = [
  "in which year",
  "in what year",
  "what is the name of",
  "what is the",
  "which of the following",
  "who was the",
  "who is the",
  "who was",
  "who is",
  "who",
  "what was the",
  "what is",
  "what are",
  "what",
  "which",
  "where",
  "when",
  "why",
  "how many",
  "how much",
  "how",
  "name the",
  "state the",
];

/**
 * Turn a question + its answer into a short, readable coverage key.
 *
 * This is deliberately deterministic. An LLM would produce prettier keys, but
 * it would also be a second failure mode in the generation path and an extra
 * cost on every job, for a list whose only job is to say "don't repeat this".
 */
export function extractConceptKey(stem: string, answerBody: string | null): string {
  let subject = normalizeStem(stem);

  for (const prefix of INTERROGATIVE_PREFIXES) {
    if (subject.startsWith(`${prefix} `)) {
      subject = subject.slice(prefix.length + 1);
      break;
    }
  }

  subject = subject.replace(/\s+/g, " ").trim();
  // Keep it short: a coverage list is a hint, not a transcript.
  const words = subject.split(" ");
  if (words.length > 9) subject = words.slice(0, 9).join(" ");

  const answer = answerBody ? answerBody.trim().replace(/\s+/g, " ").slice(0, 60) : "";
  if (!subject) return answer ? `— → ${answer}` : "";
  return answer ? `${subject} → ${answer}` : subject;
}

export type CoverageDigest = {
  /** The block that goes into the prompt. Empty when there is nothing to say. */
  text: string;
  questionCount: number;
  conceptCount: number;
  estimatedTokens: number;
  /** True when concepts had to be dropped to fit the budget. */
  truncated: boolean;
};

export type CoverageInput = {
  topic: string;
  subtopics?: string[] | null;
  /** Existing questions considered, before the budget is applied. */
  maxQuestions?: number;
  /** Token ceiling for the rendered block. */
  maxTokens?: number;
  /** Include a handful of FULL existing stems instead of only concept keys. */
  includeExamples?: boolean;
};

const DEFAULT_MAX_QUESTIONS = 300;
const DEFAULT_MAX_TOKENS = 2500;

/**
 * Build the "ALREADY COVERED" block for a topic.
 *
 * Retrieval is TWO-PASS, precision first:
 *
 *   1. questions tagged with exactly this topic, and
 *   2. only if that yields too few, top up with bm25-ranked FTS hits.
 *
 * The order matters. An OR-based FTS match over a topic NAME is broad — asking
 * about "Operating Systems" also matches any question containing "system",
 * including one about the Solar System. Those entries cost budget and dilute
 * the instruction, so they are a fallback rather than the primary source.
 */
export async function buildCoverageDigest(input: CoverageInput): Promise<CoverageDigest> {
  const maxQuestions = Math.min(1000, Math.max(1, input.maxQuestions ?? DEFAULT_MAX_QUESTIONS));
  const maxTokens = Math.min(8000, Math.max(100, input.maxTokens ?? DEFAULT_MAX_TOKENS));

  type Row = { id: string; stem: string; answer: string | null; topic: string | null };

  const selectColumns = sql`
    select q.id, q.stem, q.topic,
      (select qo.body from question_options qo
        where qo.question_id = q.id and qo.is_correct = 1 limit 1) as answer
    from questions q
  `;

  // ── Pass 1: exactly this topic ───────────────────────────────────────────
  const byTopic = await db().all<Row>(sql`
    ${selectColumns}
    where lower(coalesce(q.topic, '')) = lower(${input.topic})
    limit ${maxQuestions}
  `);
  logInfo("coverage", `topic tag pass for "${input.topic}"`, { matched: byTopic.length });

  const rows: Row[] = [...byTopic];
  const seenIds = new Set(rows.map((row) => row.id));

  // ── Pass 2: top up with FTS only when the topic alone is thin ────────────
  const TOP_UP_BELOW = 10;
  if (rows.length < TOP_UP_BELOW) {
    // AND, not the default OR: every surviving term must appear, so a shared
    // word like "systems" cannot drag in "the Solar System". Short glue words
    // are already dropped by buildFtsMatch's length filter.
    const match = buildFtsMatch([input.topic, ...(input.subtopics ?? [])].join(" "), {
      operator: "AND",
    });

    if (match) {
      const related = await db().all<Row>(sql`
        ${selectColumns}
        where q.id in (
          select question_id from questions_fts
          where questions_fts match ${match}
          order by rank
          limit ${maxQuestions}
        )
        limit ${maxQuestions}
      `);

      logInfo("coverage", `fts top-up for "${input.topic}"`, { match: String(match), hits: related.length });
      for (const row of related) {
        if (seenIds.has(row.id)) continue;
        seenIds.add(row.id);
        rows.push(row);
      }
    } else {
      logInfo("coverage", `no fts terms survived for "${input.topic}"`);
    }
  }

  // ── stage B: concept keys, deduplicated ──────────────────────────────────
  const seen = new Set<string>();
  const concepts: string[] = [];

  for (const row of rows) {
    const key = extractConceptKey(row.stem, row.answer);
    if (!key) continue;
    const dedupeKey = normalizeStem(key);
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    concepts.push(key);
  }

  // ── stage C: fit the budget ──────────────────────────────────────────────
  const header = [
    `ALREADY COVERED — ${input.topic}${
      rows.length > 0 ? ` (${rows.length} questions in the bank)` : ""
    }`,
    "Do not create questions testing these facts. If covering a listed concept is",
    "unavoidable, it must require a materially different, deeper fact.",
    "",
  ].join("\n");

  const budgetForConcepts = Math.max(20, maxTokens - estimateTokens(header));
  const lines: string[] = [];
  let used = 0;
  let truncated = false;

  for (const concept of concepts) {
    const line = `- ${concept}`;
    const cost = estimateTokens(`${line}\n`);
    if (used + cost > budgetForConcepts) {
      truncated = true;
      break;
    }
    lines.push(line);
    used += cost;
  }

  if (truncated && lines.length > 0) {
    lines.push(`- …and ${concepts.length - lines.length} more already-covered concepts`);
  }

  // Optional: a few full stems so the model can see the actual phrasing it
  // must not imitate. Bigger, so it is opt-in per job.
  if (input.includeExamples && rows.length > 0) {
    const examples = rows
      .slice(0, 10)
      .map((row) => `- ${row.stem.replace(/\s+/g, " ").slice(0, 140)}`);
    const block = ["", "EXAMPLES OF EXISTING QUESTIONS (for style only):", ...examples].join("\n");
    if (used + estimateTokens(block) <= maxTokens) {
      lines.push(block);
      used += estimateTokens(block);
    }
  }

  const text = concepts.length === 0 && lines.length === 0 ? "" : `${header}${lines.join("\n")}`;

  return {
    text,
    questionCount: rows.length,
    conceptCount: concepts.length,
    estimatedTokens: estimateTokens(text),
    truncated,
  };
}
