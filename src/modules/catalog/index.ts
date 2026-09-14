/**
 * Public surface of the catalog module.
 * PLAN.md §2.4 — other modules import from here, never from `service.ts`
 * internals or the raw tables.
 */

export {
  listRootCategories,
  getCategoryBySlug,
  listSetsForCategory,
  listCategoriesForAdmin,
  groupSets,
  type CategoryCard,
  type SetCardData,
} from "./service";

export {
  createCategory,
  updateCategory,
  setCategoryStatus,
  reorderCategories,
  archiveCategory,
  type CreateCategoryInput,
  type UpdateCategoryInput,
} from "./admin";

export { CATEGORY_ICONS, CATEGORY_ACCENTS, type CategoryIconName, type CategoryAccent } from "./content-options";