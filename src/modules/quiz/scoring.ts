/**
 * Scoring. PLAN.md §11.6.
 *
 * Computed and persisted SERVER-SIDE only. The client's running score is
 * display-only and is never trusted — a client-submitted score is ignored.
 *
 * Unanswered questions count AGAINST the candidate (percent is over the total,
 * not over what was attempted). That is how a real exam paper behaves, and it
 * is why the runner nags before finishing with blanks.
 */

export type AnswerOutcome = {
  isCorrect: number | null;
};

export type Score = {
  total: number;
  correct: number;
  wrong: number;
  skipped: number;
  /** correct / total * 100, rounded to 2dp. Unanswered counts against you. */
  percent: number;
  /** null when the set defines no passing mark. */
  passed: boolean | null;
};

export function computeScore(input: {
  total: number;
  answers: AnswerOutcome[];
  passingPercent: number | null;
}): Score {
  const { total, answers, passingPercent } = input;

  let correct = 0;
  let wrong = 0;
  for (const answer of answers) {
    if (answer.isCorrect === 1) correct++;
    else if (answer.isCorrect === 0) wrong++;
  }

  const answered = correct + wrong;
  const skipped = Math.max(0, total - answered);
  const percent = total > 0 ? Math.round((correct / total) * 10000) / 100 : 0;

  return {
    total,
    correct,
    wrong,
    skipped,
    percent,
    passed: passingPercent == null ? null : percent >= passingPercent,
  };
}

/**
 * Fisher–Yates using a CSPRNG.
 *
 * Deliberately not `Math.random()`: a predictable shuffle is a cheat vector,
 * because a candidate who can reproduce the order can pre-plan which questions
 * they will see (§11.3).
 */
export function shuffleWithCrypto<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    const a = out[i]!;
    out[i] = out[j]!;
    out[j] = a;
  }
  return out;
}

/** Uniform random integer in [0, maxExclusive) via rejection sampling. */
function randomInt(maxExclusive: number): number {
  if (maxExclusive <= 1) return 0;
  const limit = Math.floor(0x1_0000_0000 / maxExclusive) * maxExclusive;
  const buffer = new Uint32Array(1);
  let value = 0;
  do {
    crypto.getRandomValues(buffer);
    value = buffer[0]!;
  } while (value >= limit);
  return value % maxExclusive;
}

export { randomInt };
