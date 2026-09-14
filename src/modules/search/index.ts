/**
 * Search — "find me a paper that covers this".
 *
 * ⚠️ DOCUMENTED EXCEPTION to the module-boundary rule in PLAN.md §2.4.
 *
 * Every other module reads only its own tables. Search inherently spans them:
 * a learner types a phrase from a QUESTION and expects back the SET that
 * contains it, plus the SUBJECT it lives under. Splitting that across three
 * modules would mean three round trips and a join in the caller, so this module
 * is allowed to read across `questions`, `question_set_questions`, `quiz_sets`
 * and `categories` — READ ONLY, never writing anything.
 *
 * Ranking is deliberately simple and explainable:
 *   1. more matching questions in the set
 *   2. then a title match on the set or its subject
 *   3. then alphabetical
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { categories, questions, questionSetQuestions, quizSets } from "@/db/schema";
import { buildFtsMatch } from "@/modules/questions";

export type SetSearchHit = {
  setId: string;
  setTitle: string;
  categorySlug: string;
  categoryTitle: string;
  questionCount: number;
  /** How many questions in this set matched the text. 0 if it matched by title. */
  matchedCount: number;
  /** A few matching stems, for "why did this match?" */
  matchedStems: string[];
  titleMatched: boolean;
};

const MAX_FTS_HITS = 200;
/** D1 caps bound parameters per statement at ~100; stay clearly under. */
const MAX_BOUND_PARAMS = 90;

export async function searchSets(rawQuery: string, limit = 20): Promise<SetSearchHit[]> {
  const query = rawQuery.trim();
  if (query.length < 2) return [];

  // 1. Does the query match any question text at all? (FTS5, bm25-ranked)
  //
  // The match string is passed to the subqueries below rather than materialising
  // an id list: D1 allows ~100 bound parameters per statement, and `inArray`
  // with a few hundred FTS hits blows straight through that.
  const match = buildFtsMatch(query);
  const needle = `%${query.toLowerCase()}%`;

  // 2a. Sets containing a question that matches the text.
  const byQuestion = match
    ? await db()
        .select({
          setId: quizSets.id,
          setTitle: quizSets.title,
          categorySlug: categories.slug,
          categoryTitle: categories.title,
          questionId: questionSetQuestions.questionId,
        })
        .from(questionSetQuestions)
        .innerJoin(quizSets, eq(quizSets.id, questionSetQuestions.setId))
        .innerJoin(categories, eq(categories.id, quizSets.categoryId))
        .where(
          and(
            sql`${questionSetQuestions.questionId} in (
              select question_id from questions_fts
              where questions_fts match ${match}
              order by rank
              limit ${MAX_FTS_HITS}
            )`,
            eq(quizSets.status, "published"),
            eq(categories.status, "published"),
          ),
        )
    : [];

  // 2b. Sets whose own title, or their subject's title, matches.
  const byTitle = await db()
    .select({
      setId: quizSets.id,
      setTitle: quizSets.title,
      categorySlug: categories.slug,
      categoryTitle: categories.title,
    })
    .from(quizSets)
    .innerJoin(categories, eq(categories.id, quizSets.categoryId))
    .where(
      and(
        eq(quizSets.status, "published"),
        eq(categories.status, "published"),
        sql`(lower(${quizSets.title}) like ${needle} or lower(${categories.title}) like ${needle})`,
      ),
    );

  // Stems for the matched questions, fetched in bounded chunks (D1 caps bound
  // parameters per statement at ~100).
  const matchedQuestionIds = [...new Set(byQuestion.map((r) => r.questionId))];
  const stemById = new Map<string, string>();
  for (let i = 0; i < matchedQuestionIds.length; i += MAX_BOUND_PARAMS) {
    const chunk = matchedQuestionIds.slice(i, i + MAX_BOUND_PARAMS);
    const rows = await db()
      .select({ id: questions.id, stem: questions.stem })
      .from(questions)
      .where(inArray(questions.id, chunk));
    for (const row of rows) stemById.set(row.id, row.stem);
  }

  // 3. Merge.
  const merged = new Map<string, SetSearchHit>();

  for (const row of byTitle) {
    merged.set(row.setId, {
      setId: row.setId,
      setTitle: row.setTitle,
      categorySlug: row.categorySlug,
      categoryTitle: row.categoryTitle,
      questionCount: 0,
      matchedCount: 0,
      matchedStems: [],
      titleMatched: true,
    });
  }

  for (const row of byQuestion) {
    const hit =
      merged.get(row.setId) ??
      {
        setId: row.setId,
        setTitle: row.setTitle,
        categorySlug: row.categorySlug,
        categoryTitle: row.categoryTitle,
        questionCount: 0,
        matchedCount: 0,
        matchedStems: [],
        titleMatched: false,
      };
    hit.matchedCount += 1;
    const stem = stemById.get(row.questionId);
    if (stem && hit.matchedStems.length < 3) hit.matchedStems.push(stem);
    merged.set(row.setId, hit);
  }

  const hits = [...merged.values()];
  if (hits.length === 0) return [];

  // 4. One grouped count for the sets we are about to show — not N queries.
  const ids = hits.map((h) => h.setId);
  const counts = await db()
    .select({
      setId: questionSetQuestions.setId,
      n: sql<number>`count(*)`,
    })
    .from(questionSetQuestions)
    .where(inArray(questionSetQuestions.setId, ids))
    .groupBy(questionSetQuestions.setId);
  const countBySet = new Map(counts.map((c) => [c.setId, Number(c.n)]));

  for (const hit of hits) hit.questionCount = countBySet.get(hit.setId) ?? 0;

  return hits
    .sort((a, b) => {
      if (b.matchedCount !== a.matchedCount) return b.matchedCount - a.matchedCount;
      if (a.titleMatched !== b.titleMatched) return a.titleMatched ? -1 : 1;
      return a.setTitle.localeCompare(b.setTitle);
    })
    .slice(0, limit);
}
