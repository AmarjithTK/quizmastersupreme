/**
 * Catalog module — owns `categories`, `quiz_sets`, `question_set_questions`.
 * PLAN.md §7.1.
 *
 * The content tree is exactly two levels deep (§2.1). There is no recursive
 * query here and no parent lookup, because there is no third level.
 *
 * Query discipline (§17.2): screen 1 and screen 2 each render from ONE query.
 * The aggregate counts are computed with a LEFT JOIN + GROUP BY rather than a
 * per-card correlated subquery, so cost stays flat as the catalog grows.
 */

import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { categories, questionSetQuestions, quizSets } from "@/db/schema";

export type PublishState = "draft" | "published" | "archived";

type CategoryRowAdmin = {
  id: string;
  slug: string;
  title: string;
  subtitle: string | null;
  description: string | null;
  icon: string | null;
  accentColor: string | null;
  sortOrder: number;
  status: PublishState;
  createdAt: number;
  updatedAt: number;
  setCount: number;
};

export type CategoryCard = {
  id: string;
  slug: string;
  title: string;
  subtitle: string | null;
  icon: string | null;
  accentColor: string | null;
  setCount: number;
  questionCount: number;
};

export type SetCardData = {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  groupLabel: string | null;
  mode: string;
  difficulty: string;
  timeLimitSeconds: number | null;
  questionCount: number;
};

/**
 * Screen 1. Published root categories with their published set/question counts.
 */
export async function listRootCategories(): Promise<CategoryCard[]> {
  const rows = await db()
    .select({
      id: categories.id,
      slug: categories.slug,
      title: categories.title,
      subtitle: categories.subtitle,
      icon: categories.icon,
      accentColor: categories.accentColor,
      setCount: sql<number>`count(distinct ${quizSets.id})`,
      questionCount: sql<number>`count(distinct ${questionSetQuestions.questionId})`,
    })
    .from(categories)
    .leftJoin(
      quizSets,
      and(eq(quizSets.categoryId, categories.id), eq(quizSets.status, "published")),
    )
    .leftJoin(questionSetQuestions, eq(questionSetQuestions.setId, quizSets.id))
    .where(eq(categories.status, "published"))
    .groupBy(categories.id)
    .orderBy(asc(categories.sortOrder), asc(categories.title));

  return rows.map((r) => ({
    ...r,
    setCount: Number(r.setCount ?? 0),
    questionCount: Number(r.questionCount ?? 0),
  }));
}

export async function getCategoryBySlug(slug: string): Promise<CategoryCard | null> {
  const rows = await db()
    .select({
      id: categories.id,
      slug: categories.slug,
      title: categories.title,
      subtitle: categories.subtitle,
      icon: categories.icon,
      accentColor: categories.accentColor,
      description: categories.description,
      setCount: sql<number>`count(distinct ${quizSets.id})`,
      questionCount: sql<number>`count(distinct ${questionSetQuestions.questionId})`,
    })
    .from(categories)
    .leftJoin(
      quizSets,
      and(eq(quizSets.categoryId, categories.id), eq(quizSets.status, "published")),
    )
    .leftJoin(questionSetQuestions, eq(questionSetQuestions.setId, quizSets.id))
    .where(and(eq(categories.slug, slug), eq(categories.status, "published")))
    .groupBy(categories.id)
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  return {
    ...row,
    setCount: Number(row.setCount ?? 0),
    questionCount: Number(row.questionCount ?? 0),
  };
}

/** Screen 2. Published sets inside one category, one query, plus counts. */
export async function listSetsForCategory(categoryId: string): Promise<SetCardData[]> {
  const rows = await db()
    .select({
      id: quizSets.id,
      slug: quizSets.slug,
      title: quizSets.title,
      description: quizSets.description,
      groupLabel: quizSets.groupLabel,
      mode: quizSets.mode,
      difficulty: quizSets.difficulty,
      timeLimitSeconds: quizSets.timeLimitSeconds,
      questionCount: sql<number>`count(${questionSetQuestions.questionId})`,
    })
    .from(quizSets)
    .leftJoin(questionSetQuestions, eq(questionSetQuestions.setId, quizSets.id))
    .where(and(eq(quizSets.categoryId, categoryId), eq(quizSets.status, "published")))
    .groupBy(quizSets.id)
    .orderBy(asc(quizSets.sortOrder), asc(quizSets.title));

  return rows.map((r) => ({ ...r, questionCount: Number(r.questionCount ?? 0) }));
}

/**
 * Group sets by their display-only `group_label`, preserving sort order.
 * Returns a single ungrouped bucket when no labels are set, so screen 2 can
 * render one flat grid without a special case.
 */
export function groupSets(sets: SetCardData[]): { label: string | null; sets: SetCardData[] }[] {
  const buckets = new Map<string, SetCardData[]>();
  const order: string[] = [];

  for (const set of sets) {
    const key = set.groupLabel ?? "";
    if (!buckets.has(key)) {
      buckets.set(key, []);
      order.push(key);
    }
    buckets.get(key)!.push(set);
  }

  return order.map((key) => ({
    label: key === "" ? null : key,
    sets: buckets.get(key)!,
  }));
}

/** Admin list: ALL categories regardless of status, for the management screen. */
export async function listCategoriesForAdmin(): Promise<CategoryRowAdmin[]> {
  const rows = await db()
    .select({
      id: categories.id,
      slug: categories.slug,
      title: categories.title,
      subtitle: categories.subtitle,
      description: categories.description,
      icon: categories.icon,
      accentColor: categories.accentColor,
      sortOrder: categories.sortOrder,
      status: categories.status,
      createdAt: categories.createdAt,
      updatedAt: categories.updatedAt,
      setCount: sql<number>`count(${quizSets.id})`,
    })
    .from(categories)
    .leftJoin(quizSets, eq(quizSets.categoryId, categories.id))
    .groupBy(categories.id)
    .orderBy(asc(categories.sortOrder), asc(categories.title));

  return rows.map((row) => ({
    ...row,
    // The Drizzle column type is `string` even with a CHECK constraint; the
    // union is asserted here so the admin UI gets a narrow status type.
    status: row.status as PublishState,
    setCount: Number(row.setCount ?? 0),
  }));
}
