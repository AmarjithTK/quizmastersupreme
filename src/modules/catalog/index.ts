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
  listSetsForAdmin,
  groupSets,
  type CategoryCard,
  type SetCardData,
  type SetRowAdmin,
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

export {
  createSet,
  updateSet,
  setSetStatus,
  archiveSet,
  reorderSets,
  SET_MODES,
  SET_DIFFICULTIES,
  SET_STATUSES,
  type SetMode,
  type SetStatus,
  type CreateSetInput,
  type UpdateSetInput,
} from "./admin-sets";

export { CATEGORY_ICONS, CATEGORY_ACCENTS, type CategoryIconName, type CategoryAccent } from "./content-options";