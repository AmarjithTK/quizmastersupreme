/**
 * Quiz engine. PLAN.md §11.
 *
 * The two rules this file exists to enforce:
 *
 *   §2.6 — a question payload delivered BEFORE answering contains no
 *          correctness, no explanation and no backstory. Those are returned
 *          only in the response to a submitted answer. Otherwise the answer key
 *          is readable from the browser's network tab.
 *
 *   §11.5 — the server owns the clock. `server_deadline_at` is computed at
 *          start and a late submission is rejected regardless of what the
 *          client believes the time is.
 *
 * Resume is not a restore operation: the attempt row and every answer are
 * persisted as they happen, so "resume" is just "read the existing attempt"
 * (§11.4). The partial unique index `ux_attempt_active` makes that a database
 * invariant rather than application logic.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db/client";
import {
  newId,
  nowMs,
  questionOptions,
  questionSetQuestions,
  questions,
  quizAttemptAnswers,
  quizAttempts,
  quizSets,
  type AttemptStatus,
  type OptionKey,
  type QuizAttempt,
  type QuizSet,
} from "@/db/schema";
import { conflict, notFound, validationError } from "@/lib/errors";
import { recordAttemptStarted, recordAnswerSeen, recordSetCompletion } from "@/modules/progress";
import { computeScore, shuffleWithCrypto, type Score } from "./scoring";
import { assertTransition } from "./state-machine";

/** Late answers are accepted for this long, to cover in-flight requests (§11.5). */
export const SUBMISSION_GRACE_MS = 5_000;

/**
 * Ceiling on a single question's recorded time. Anything longer is treated as
 * "they walked away", not as time on task (§11.6).
 */
export const MAX_QUESTION_MS = 15 * 60 * 1000;

// ── payload shapes ───────────────────────────────────────────────────────────

/** A question as delivered BEFORE it is answered. Note what is absent. */
export type AttemptQuestion = {
  index: number;
  questionId: string;
  stem: string;
  stemFormat: string;
  options: Array<{ key: OptionKey; body: string }>;
  difficulty: string;
  topic: string | null;
  /** Whether this question has already been answered in this attempt. */
  answered: boolean;
};

export type AnswerResult = {
  isCorrect: boolean;
  correctOptionKey: OptionKey;
  explanation: string | null;
  backstory: string | null;
  backstoryFormat: string;
  runningScore: { correct: number; wrong: number; answered: number };
  nextIndex: number;
  isLast: boolean;
};

export type AttemptState = {
  attemptId: string;
  setId: string;
  setTitle: string;
  mode: string;
  status: AttemptStatus;
  totalQuestions: number;
  /** Where the runner should open: the first unanswered question. */
  resumeIndex: number;
  answeredCount: number;
  correctCount: number;
  wrongCount: number;
  skippedCount: number;
  remainingSeconds: number | null;
  serverDeadlineAt: number | null;
  /** When the paper was started — used for the elapsed counter on untimed sets. */
  startedAt: number;
  /** Accumulated time ON TASK (sum of capped per-answer gaps), in ms. */
  timeSpentMs: number;
  /** Question ids with their outcome. Correctness only for ANSWERED ones. */
  answers: Array<{ questionId: string; index: number; selectedOptionKey: string | null; isCorrect: number | null }>;
};

export type AttemptSummary = {
  attemptId: string;
  setId: string;
  setTitle: string;
  status: AttemptStatus;
  score: Score;
  startedAt: number;
  completedAt: number | null;
  timeSpentMs: number;
  questions: Array<{
    index: number;
    questionId: string;
    stem: string;
    options: Array<{ key: OptionKey; body: string; isCorrect: boolean }>;
    selectedOptionKey: string | null;
    isCorrect: number | null;
    /** Server-measured time on this question. */
    timeTakenMs: number;
    explanation: string | null;
    backstory: string | null;
    backstoryFormat: string;
  }>;
};

// ── internal helpers ─────────────────────────────────────────────────────────

function parseOrder(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    console.error("Corrupt question_order on an attempt; treating as empty");
    return [];
  }
}

async function loadPublishedSet(setId: string): Promise<QuizSet> {
  const set = (await db().select().from(quizSets).where(eq(quizSets.id, setId)).limit(1))[0];
  if (!set) throw notFound("Quiz set not found.");
  if (set.status !== "published") throw notFound("That quiz set is not available.");
  return set;
}

async function requireOwnedAttempt(attemptId: string, userId: string): Promise<QuizAttempt> {
  const attempt = (
    await db()
      .select()
      .from(quizAttempts)
      .where(eq(quizAttempts.id, attemptId))
      .limit(1)
  )[0];

  if (!attempt) throw notFound("Attempt not found.");
  // Ownership is enforced in the query result, not in a UI check (§16.2).
  if (attempt.userId !== userId) throw notFound("Attempt not found.");
  return attempt;
}

async function findActiveAttempt(userId: string, setId: string): Promise<QuizAttempt | null> {
  const row = (
    await db()
      .select()
      .from(quizAttempts)
      .where(
        and(
          eq(quizAttempts.userId, userId),
          eq(quizAttempts.setId, setId),
          eq(quizAttempts.status, "in_progress"),
        ),
      )
      .limit(1)
  )[0];
  return row ?? null;
}

async function loadSetQuestionIds(setId: string): Promise<string[]> {
  const rows = await db()
    .select({ id: questionSetQuestions.questionId })
    .from(questionSetQuestions)
    .innerJoin(questions, eq(questions.id, questionSetQuestions.questionId))
    // Playability lives on the SET, not the question: anything active that is
    // attached to this (published) set is playable. Rejected/archived excluded.
    .where(and(eq(questionSetQuestions.setId, setId), eq(questions.status, "active")))
    .orderBy(questionSetQuestions.sortOrder);
  return rows.map((r) => r.id);
}

async function recount(attemptId: string) {
  const row = (
    await db()
      .select({
        answered: sql<number>`count(*)`,
        correct: sql<number>`sum(case when ${quizAttemptAnswers.isCorrect} = 1 then 1 else 0 end)`,
        wrong: sql<number>`sum(case when ${quizAttemptAnswers.isCorrect} = 0 then 1 else 0 end)`,
      })
      .from(quizAttemptAnswers)
      .where(eq(quizAttemptAnswers.attemptId, attemptId))
  )[0];

  return {
    answeredCount: Number(row?.answered ?? 0),
    correctCount: Number(row?.correct ?? 0),
    wrongCount: Number(row?.wrong ?? 0),
  };
}

/**
 * Mark a timed attempt expired once its deadline has passed, scoring it from
 * whatever answers were stored. Idempotent: a terminal attempt is returned
 * unchanged.
 */
async function settleIfExpired(attempt: QuizAttempt): Promise<QuizAttempt> {
  if (attempt.status !== "in_progress") return attempt;
  if (attempt.serverDeadlineAt == null) return attempt;
  if (Date.now() <= attempt.serverDeadlineAt) return attempt;

  return finishAttempt(attempt, "expired");
}

async function finishAttempt(
  attempt: QuizAttempt,
  status: Extract<AttemptStatus, "completed" | "expired" | "abandoned">,
): Promise<QuizAttempt> {
  assertTransition(attempt.status as AttemptStatus, status);

  const counts = await recount(attempt.id);
  const now = nowMs();

  // Add the time on the LAST question, which was never submitted (they read it
  // and finished, or the clock ran out). Capped for the same reason as above.
  const trailingMs = Math.min(Math.max(0, now - attempt.lastActivityAt), MAX_QUESTION_MS);

  await db()
    .update(quizAttempts)
    .set({
      status,
      answeredCount: counts.answeredCount,
      correctCount: counts.correctCount,
      wrongCount: counts.wrongCount,
      skippedCount: Math.max(0, attempt.totalQuestions - counts.answeredCount),
      timeSpentMs: attempt.timeSpentMs + trailingMs,
      // An expired attempt ended at its deadline, not when we noticed.
      completedAt: status === "expired" ? attempt.serverDeadlineAt : now,
      lastActivityAt: now,
      updatedAt: now,
    })
    .where(eq(quizAttempts.id, attempt.id));

  // Abandoning does not count as a completion.
  if (status !== "abandoned") {
    await recordSetCompletion(attempt.userId, attempt.setId, {
      correct: counts.correctCount,
      total: attempt.totalQuestions,
      at: now,
    });
  }

  return (await db().select().from(quizAttempts).where(eq(quizAttempts.id, attempt.id)).limit(1))[0]!;
}

async function loadQuestionRows(questionIds: string[]) {
  if (questionIds.length === 0) return { questions: [], options: [] };

  const questionRows = await db()
    .select({
      id: questions.id,
      stem: questions.stem,
      stemFormat: questions.stemFormat,
      difficulty: questions.difficulty,
      topic: questions.topic,
      explanation: questions.explanation,
      backstory: questions.backstory,
      backstoryFormat: questions.backstoryFormat,
    })
    .from(questions)
    .where(inArray(questions.id, questionIds));

  const optionRows = await db()
    .select({
      questionId: questionOptions.questionId,
      key: questionOptions.optionKey,
      body: questionOptions.body,
      isCorrect: questionOptions.isCorrect,
      sortOrder: questionOptions.sortOrder,
    })
    .from(questionOptions)
    .where(inArray(questionOptions.questionId, questionIds))
    .orderBy(questionOptions.sortOrder);

  return { questions: questionRows, options: optionRows };
}

// ── public API ───────────────────────────────────────────────────────────────

/**
 * Start a new attempt, or hand back the existing in-progress one.
 *
 * Race-safe by construction: if two requests start at once, the partial unique
 * index rejects the second insert and we return the winner's attempt. The
 * "resume" branch and the "lost the race" branch are the same code path.
 */
export async function startOrResumeAttempt(
  userId: string,
  setId: string,
): Promise<{ attempt: QuizAttempt; resumed: boolean; set: QuizSet }> {
  const set = await loadPublishedSet(setId);

  const existing = await findActiveAttempt(userId, setId);
  if (existing) {
    const settled = await settleIfExpired(existing);
    return { attempt: settled, resumed: true, set };
  }

  const available = await loadSetQuestionIds(setId);
  if (available.length === 0) {
    throw conflict("This set has no questions yet.");
  }

  const limited =
    set.questionLimit != null && set.questionLimit > 0
      ? available.slice(0, set.questionLimit)
      : available;
  const ordered = set.shuffleQuestions === 1 ? shuffleWithCrypto(limited) : limited;

  const now = nowMs();
  const total = ordered.length;
  const deadline =
    set.timeLimitSeconds != null ? now + set.timeLimitSeconds * 1000 : null;

  const attempt: QuizAttempt = {
    id: newId(),
    userId,
    setId,
    status: "in_progress",
    // FROZEN: editing the set later cannot change a paper already in flight.
    questionOrder: JSON.stringify(ordered),
    optionOrder: null,
    totalQuestions: total,
    currentIndex: 0,
    answeredCount: 0,
    correctCount: 0,
    wrongCount: 0,
    skippedCount: 0,
    timeLimitSeconds: set.timeLimitSeconds,
    serverDeadlineAt: deadline,
    timeSpentMs: 0,
    startedAt: now,
    lastActivityAt: now,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
  };

  try {
    await db().insert(quizAttempts).values(attempt);
  } catch (error) {
    // Lost the race against a concurrent start: use the attempt that won.
    const raced = await findActiveAttempt(userId, setId);
    if (raced) return { attempt: raced, resumed: true, set };
    throw error;
  }

  await recordAttemptStarted(userId, setId, now);
  return { attempt, resumed: false, set };
}

export async function getAttemptState(attemptId: string, userId: string): Promise<AttemptState> {
  const loaded = await requireOwnedAttempt(attemptId, userId);
  const attempt = await settleIfExpired(loaded);
  const set = (await db().select().from(quizSets).where(eq(quizSets.id, attempt.setId)).limit(1))[0];

  const order = parseOrder(attempt.questionOrder);
  const answerRows = await db()
    .select({
      questionId: quizAttemptAnswers.questionId,
      selectedOptionKey: quizAttemptAnswers.selectedOptionKey,
      isCorrect: quizAttemptAnswers.isCorrect,
    })
    .from(quizAttemptAnswers)
    .where(eq(quizAttemptAnswers.attemptId, attemptId));

  const byQuestion = new Map(answerRows.map((a) => [a.questionId, a]));
  const answers = order.map((questionId, index) => {
    const row = byQuestion.get(questionId);
    return {
      questionId,
      index,
      selectedOptionKey: row?.selectedOptionKey ?? null,
      isCorrect: row?.isCorrect ?? null,
    };
  });

  const firstUnanswered = answers.findIndex((a) => a.selectedOptionKey === null);
  const resumeIndex = firstUnanswered === -1 ? Math.max(0, order.length - 1) : firstUnanswered;

  const remainingSeconds =
    attempt.serverDeadlineAt != null
      ? Math.max(0, Math.floor((attempt.serverDeadlineAt - Date.now()) / 1000))
      : null;

  return {
    attemptId: attempt.id,
    setId: attempt.setId,
    setTitle: set?.title ?? "Quiz",
    mode: set?.mode ?? "practice",
    status: attempt.status as AttemptStatus,
    totalQuestions: attempt.totalQuestions,
    resumeIndex,
    answeredCount: attempt.answeredCount,
    correctCount: attempt.correctCount,
    wrongCount: attempt.wrongCount,
    skippedCount: Math.max(0, attempt.totalQuestions - attempt.answeredCount),
    remainingSeconds,
    serverDeadlineAt: attempt.serverDeadlineAt,
    startedAt: attempt.startedAt,
    timeSpentMs: attempt.timeSpentMs,
    answers,
  };
}

/**
 * Questions for the runner, WITHOUT any correctness data.
 *
 * `answered` is included so the runner can render its question map; nothing
 * here reveals which option is right.
 */
export async function getAttemptQuestions(
  attemptId: string,
  userId: string,
  from: number,
  count: number,
): Promise<AttemptQuestion[]> {
  const loaded = await requireOwnedAttempt(attemptId, userId);
  const attempt = await settleIfExpired(loaded);
  const order = parseOrder(attempt.questionOrder);

  const slice = order.slice(Math.max(0, from), Math.max(0, from) + Math.max(1, count));
  if (slice.length === 0) return [];

  const { questions: questionRows, options: optionRows } = await loadQuestionRows(slice);
  const questionById = new Map(questionRows.map((q) => [q.id, q]));

  const answeredRows = await db()
    .select({ questionId: quizAttemptAnswers.questionId })
    .from(quizAttemptAnswers)
    .where(
      and(
        eq(quizAttemptAnswers.attemptId, attemptId),
        inArray(quizAttemptAnswers.questionId, slice),
      ),
    );
  const answeredIds = new Set(answeredRows.map((r) => r.questionId));

  // Rebuild in the ATTEMPT's order rather than the query's order.
  return slice.flatMap((questionId, offset) => {
    const question = questionById.get(questionId);
    if (!question) return [];
    return [
      {
        index: Math.max(0, from) + offset,
        questionId,
        stem: question.stem,
        stemFormat: question.stemFormat,
        // NOTE: no isCorrect, no explanation, no backstory — deliberate (§2.6).
        options: optionRows
          .filter((o) => o.questionId === questionId)
          .map((o) => ({ key: o.key as OptionKey, body: o.body })),
        difficulty: question.difficulty,
        topic: question.topic,
        answered: answeredIds.has(questionId),
      },
    ];
  });
}

export async function getAttemptQuestion(
  attemptId: string,
  userId: string,
  index: number,
): Promise<AttemptQuestion | null> {
  const rows = await getAttemptQuestions(attemptId, userId, index, 1);
  return rows[0] ?? null;
}

/**
 * Submit (or re-submit) an answer. Idempotent: the composite primary key on
 * (attempt_id, question_id) turns a double-click into an update, never a
 * second row (§2.5).
 */
export async function submitAnswer(
  attemptId: string,
  userId: string,
  input: {
    questionId: string;
    selectedOptionKey: OptionKey | null;
    timeTakenMs?: number;
    clientSeq?: number;
  },
): Promise<AnswerResult> {
  const loaded = await requireOwnedAttempt(attemptId, userId);

  if (loaded.status !== "in_progress") {
    throw conflict("This attempt has already finished.");
  }

  const now = Date.now();
  // Check the clock BEFORE settling. If we settled first, every late answer
  // would be rejected and the grace window would be dead code — it exists
  // precisely so an in-flight request that lands a moment late still counts.
  if (loaded.serverDeadlineAt != null && now > loaded.serverDeadlineAt + SUBMISSION_GRACE_MS) {
    await settleIfExpired(loaded);
    throw conflict("The time limit for this attempt has passed.");
  }
  const attempt = loaded;

  const order = parseOrder(attempt.questionOrder);
  const index = order.indexOf(input.questionId);
  if (index === -1) {
    throw validationError("That question is not part of this attempt.");
  }

  const options = await db()
    .select({
      key: questionOptions.optionKey,
      isCorrect: questionOptions.isCorrect,
    })
    .from(questionOptions)
    .where(eq(questionOptions.questionId, input.questionId));

  const correct = options.find((o) => o.isCorrect === 1);
  if (!correct) {
    throw conflict("That question has no correct option configured.");
  }
  const correctOptionKey = correct.key as OptionKey;

  if (input.selectedOptionKey !== null && !options.some((o) => o.key === input.selectedOptionKey)) {
    throw validationError("That option does not belong to this question.");
  }

  const isCorrect = input.selectedOptionKey === correctOptionKey ? 1 : 0;

  /**
   * Per-question timing is measured SERVER-SIDE, as the gap since the last
   * activity on this attempt. A client-supplied duration is not trusted: it is
   * trivially inflatable or deflatable, and the number is shown back to the
   * learner as a study signal.
   *
   * The gap is capped at MAX_QUESTION_MS so that closing the tab for a day and
   * coming back does not get recorded as "spent 8 hours on question 4".
   */
  const gap = Math.max(0, now - attempt.lastActivityAt);
  const serverTimeMs = Math.min(gap, MAX_QUESTION_MS);

  await db()
    .insert(quizAttemptAnswers)
    .values({
      attemptId,
      questionId: input.questionId,
      questionIndex: index,
      selectedOptionKey: input.selectedOptionKey,
      isCorrect,
      timeTakenMs: serverTimeMs,
      answeredAt: now,
      clientSeq: input.clientSeq ?? null,
    })
    .onConflictDoUpdate({
      target: [quizAttemptAnswers.attemptId, quizAttemptAnswers.questionId],
      set: {
        selectedOptionKey: input.selectedOptionKey,
        isCorrect,
        timeTakenMs: serverTimeMs,
        answeredAt: now,
        clientSeq: input.clientSeq ?? null,
      },
    });

  const counts = await recount(attemptId);

  await db()
    .update(quizAttempts)
    .set({
      ...counts,
      // Highest index reached, so the record reflects how far they got.
      currentIndex: Math.max(attempt.currentIndex, index + 1),
      skippedCount: Math.max(0, attempt.totalQuestions - counts.answeredCount),
      // Accumulated time ON TASK (sum of capped per-answer gaps), not wall
      // clock — a paper left open overnight should not read as 14 hours spent.
      timeSpentMs: attempt.timeSpentMs + serverTimeMs,
      lastActivityAt: now,
      updatedAt: now,
    })
    .where(eq(quizAttempts.id, attemptId));

  await recordAnswerSeen(userId, input.questionId, isCorrect === 1, now);

  const isLast = index >= order.length - 1;
  return buildReveal(attemptId, input.questionId, index, isLast);
}

/**
 * Assemble the post-answer reveal for ONE question.
 *
 * Callers must have established that the question was answered: `submitAnswer`
 * has just written the row, and `getAnswerReveal` checks before calling.
 */
async function buildReveal(
  attemptId: string,
  questionId: string,
  index: number,
  isLast: boolean,
): Promise<AnswerResult> {
  const options = await db()
    .select({ key: questionOptions.optionKey, isCorrect: questionOptions.isCorrect })
    .from(questionOptions)
    .where(eq(questionOptions.questionId, questionId));

  const correctOptionKey = (options.find((o) => o.isCorrect === 1)?.key ?? "A") as OptionKey;

  const answer = (
    await db()
      .select({ isCorrect: quizAttemptAnswers.isCorrect })
      .from(quizAttemptAnswers)
      .where(
        and(
          eq(quizAttemptAnswers.attemptId, attemptId),
          eq(quizAttemptAnswers.questionId, questionId),
        ),
      )
      .limit(1)
  )[0];

  const counts = await recount(attemptId);
  const revealed = (
    await db()
      .select({
        explanation: questions.explanation,
        backstory: questions.backstory,
        backstoryFormat: questions.backstoryFormat,
      })
      .from(questions)
      .where(eq(questions.id, questionId))
      .limit(1)
  )[0];

  return {
    isCorrect: answer?.isCorrect === 1,
    correctOptionKey,
    explanation: revealed?.explanation ?? null,
    backstory: revealed?.backstory ?? null,
    backstoryFormat: revealed?.backstoryFormat ?? "markdown",
    runningScore: {
      correct: counts.correctCount,
      wrong: counts.wrongCount,
      answered: counts.answeredCount,
    },
    nextIndex: isLast ? index : index + 1,
    isLast,
  };
}

/**
 * Reveal one ALREADY-ANSWERED question.
 *
 * Exists so returning to a previous question — this session or after a resume —
 * can show its backstory again. Refuses anything unanswered: without that check
 * this would be an answer-key endpoint (§2.6).
 */
export async function getAnswerReveal(
  attemptId: string,
  userId: string,
  questionId: string,
): Promise<AnswerResult> {
  const attempt = await requireOwnedAttempt(attemptId, userId);
  const order = parseOrder(attempt.questionOrder);
  const index = order.indexOf(questionId);
  if (index === -1) {
    throw validationError("That question is not part of this attempt.");
  }

  const answered = (
    await db()
      .select({ questionId: quizAttemptAnswers.questionId })
      .from(quizAttemptAnswers)
      .where(
        and(
          eq(quizAttemptAnswers.attemptId, attemptId),
          eq(quizAttemptAnswers.questionId, questionId),
        ),
      )
      .limit(1)
  )[0];

  if (!answered) {
    throw conflict("That question has not been answered yet.");
  }

  return buildReveal(attemptId, questionId, index, index >= order.length - 1);
}

export async function completeAttempt(attemptId: string, userId: string): Promise<QuizAttempt> {
  const attempt = await requireOwnedAttempt(attemptId, userId);
  if (attempt.status !== "in_progress") return attempt;
  return finishAttempt(attempt, "completed");
}

export async function abandonAttempt(attemptId: string, userId: string): Promise<QuizAttempt> {
  const attempt = await requireOwnedAttempt(attemptId, userId);
  if (attempt.status !== "in_progress") return attempt;
  return finishAttempt(attempt, "abandoned");
}

/** Full review payload, INCLUDING correctness — only valid once finished. */
export async function getAttemptSummary(
  attemptId: string,
  userId: string,
): Promise<AttemptSummary> {
  const loaded = await requireOwnedAttempt(attemptId, userId);
  const attempt = await settleIfExpired(loaded);
  const set = (await db().select().from(quizSets).where(eq(quizSets.id, attempt.setId)).limit(1))[0];

  const order = parseOrder(attempt.questionOrder);
  const { questions: questionRows, options: optionRows } = await loadQuestionRows(order);
  const questionById = new Map(questionRows.map((q) => [q.id, q]));

  const answerRows = await db()
    .select({
      questionId: quizAttemptAnswers.questionId,
      selectedOptionKey: quizAttemptAnswers.selectedOptionKey,
      isCorrect: quizAttemptAnswers.isCorrect,
      timeTakenMs: quizAttemptAnswers.timeTakenMs,
    })
    .from(quizAttemptAnswers)
    .where(eq(quizAttemptAnswers.attemptId, attemptId));
  const byQuestion = new Map(answerRows.map((a) => [a.questionId, a]));

  const score = computeScore({
    total: attempt.totalQuestions,
    answers: answerRows.map((a) => ({ isCorrect: a.isCorrect })),
    passingPercent: set?.passingPercent ?? null,
  });

  return {
    attemptId: attempt.id,
    setId: attempt.setId,
    setTitle: set?.title ?? "Quiz",
    status: attempt.status as AttemptStatus,
    score,
    startedAt: attempt.startedAt,
    completedAt: attempt.completedAt,
    timeSpentMs: attempt.timeSpentMs,
    questions: order.flatMap((questionId, index) => {
      const question = questionById.get(questionId);
      if (!question) return [];
      const answer = byQuestion.get(questionId);
      return [
        {
          index,
          questionId,
          stem: question.stem,
          options: optionRows
            .filter((o) => o.questionId === questionId)
            .map((o) => ({ key: o.key as OptionKey, body: o.body, isCorrect: o.isCorrect === 1 })),
          selectedOptionKey: (answer?.selectedOptionKey as OptionKey | null) ?? null,
          isCorrect: answer?.isCorrect ?? null,
          timeTakenMs: answer?.timeTakenMs ?? 0,
          explanation: question.explanation,
          backstory: question.backstory,
          backstoryFormat: question.backstoryFormat,
        },
      ];
    }),
  };
}
