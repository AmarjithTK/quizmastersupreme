/**
 * Admin mutations for categories (M2).
 *
 * All of these validate input, enforce the two-level content model (§2.1:
 * categories are DEPTH 1 — parents of quiz sets, nothing else), and write an
 * audit trail (§7.8). Reads (screens 1/2) live in service.ts.
 *
 * Drizzle's types make a partial update mapping awkward, so the update path
 * builds an explicit allowed-fields object rather than spreading arbitrary
 * client keys onto the row.
 */

import { eq } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { db } from "@/db/client";
import { categories, newId, nowMs, type Category } from "@/db/schema";
import { conflict, notFound, validationError } from "@/lib/errors";
import { recordAudit } from "@/modules/audit";
import { slugify } from "@/modules/questions/normalize";
import { CATEGORY_ACCENTS, CATEGORY_ICONS } from "./content-options";

export type CreateCategoryInput = {
  title: string;
  slug?: string;
  subtitle?: string | null;
  description?: string | null;
  icon?: string | null;
  accentColor?: string | null;
  sortOrder?: number;
};

export type UpdateCategoryInput = Partial<CreateCategoryInput> & {
  status?: Category["status"];
};

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_TITLE_LENGTH = 80;

function validateTitle(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) throw validationError("Title is required.");
  if (trimmed.length > MAX_TITLE_LENGTH) {
    throw validationError(`Title must be ${MAX_TITLE_LENGTH} characters or fewer.`);
  }
  return trimmed;
}

function validateSlug(input: string): string {
  const slug = input.trim();
  if (!SLUG_PATTERN.test(slug)) {
    throw validationError("Slug must contain only lowercase letters, numbers and hyphens.");
  }
  return slug;
}

function validateLook(input: { icon?: string | null; accentColor?: string | null }): void {
  if (input.icon != null && !(CATEGORY_ICONS as readonly string[]).includes(input.icon)) {
    throw validationError(`Unknown icon "${input.icon}".`);
  }
  if (
    input.accentColor != null &&
    !(CATEGORY_ACCENTS as readonly string[]).includes(input.accentColor)
  ) {
    throw validationError(`Unknown accent "${input.accentColor}".`);
  }
}

async function getCategory(id: string): Promise<Category> {
  const row = (await db().select().from(categories).where(eq(categories.id, id)).limit(1))[0];
  if (!row) throw notFound("Subject not found.");
  return row;
}

async function assertSlugFree(slug: string, exceptId?: string): Promise<void> {
  const row = (await db().select({ id: categories.id }).from(categories).where(eq(categories.slug, slug)).limit(1))[0];
  if (row && row.id !== exceptId) {
    throw conflict(`A subject with the slug "${slug}" already exists.`);
  }
}

export async function createCategory(input: CreateCategoryInput, actorId: string): Promise<Category> {
  const title = validateTitle(input.title);
  const slug = validateSlug(input.slug?.trim() || slugify(title));
  validateLook({ icon: input.icon, accentColor: input.accentColor });
  await assertSlugFree(slug);

  const now = nowMs();
  const row: Category = {
    id: newId(),
    slug,
    title,
    subtitle: input.subtitle?.trim() || null,
    description: input.description?.trim() || null,
    icon: input.icon || null,
    accentColor: input.accentColor || null,
    sortOrder: input.sortOrder ?? 0,
    status: "draft",
    createdAt: now,
    updatedAt: now,
  };

  await db().insert(categories).values(row);
  await recordAudit(actorId, "category.create", "category", row.id, null, row);
  return row;
}

export async function updateCategory(
  id: string,
  patch: UpdateCategoryInput,
  actorId: string,
): Promise<Category> {
  const before = await getCategory(id);

  const updates: Partial<Category> = {};
  if (patch.title !== undefined) updates.title = validateTitle(patch.title);
  if (patch.slug !== undefined) updates.slug = validateSlug(patch.slug);
  if (patch.subtitle !== undefined) updates.subtitle = patch.subtitle?.trim() || null;
  if (patch.description !== undefined) updates.description = patch.description?.trim() || null;
  if (patch.icon !== undefined) updates.icon = patch.icon || null;
  if (patch.accentColor !== undefined) updates.accentColor = patch.accentColor || null;
  if (patch.sortOrder !== undefined) updates.sortOrder = patch.sortOrder;
  if (patch.status !== undefined) {
    if (!["draft", "published", "archived"].includes(patch.status)) {
      throw validationError(`Unknown status "${patch.status}".`);
    }
    updates.status = patch.status;
  }
  validateLook({ icon: updates.icon, accentColor: updates.accentColor });

  if (updates.slug) await assertSlugFree(updates.slug, id);

  if (Object.keys(updates).length === 0) return before;

  await db()
    .update(categories)
    .set({ ...updates, updatedAt: nowMs() })
    .where(eq(categories.id, id));

  const after = await getCategory(id);
  await recordAudit(actorId, "category.update", "category", id, before, after);
  return after;
}

/** Thin wrapper for callers; the before/after audit lives inside updateCategory. */
export async function setCategoryStatus(
  id: string,
  status: Category["status"],
  actorId: string,
): Promise<Category> {
  return updateCategory(id, { status }, actorId);
}

export async function reorderCategories(orderedIds: string[], actorId: string): Promise<void> {
  if (orderedIds.length === 0) return;
  const statements = orderedIds.map((id, index) =>
    db()
      .update(categories)
      .set({ sortOrder: index, updatedAt: nowMs() })
      .where(eq(categories.id, id)),
  ) as unknown as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]];
  await db().batch(statements);
  await recordAudit(actorId, "category.reorder", "category", null, null, { orderedIds });
}

/**
 * "Delete" is ARCHIVE, not DROP: quiz_sets has a RESTRICT FK on category_id, so
 * a destructive delete would fail once any set exists. Archive removes the card
 * from the home grid while preserving the data, and can be reversed by
 * publishing again.
 */
export async function archiveCategory(id: string, actorId: string): Promise<Category> {
  const before = await getCategory(id);
  await db()
    .update(categories)
    .set({ status: "archived", updatedAt: nowMs() })
    .where(eq(categories.id, id));
  const after = await getCategory(id);
  await recordAudit(actorId, "category.archive", "category", id, before, after);
  return after;
}

export type { Category };