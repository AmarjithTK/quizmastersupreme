/**
 * Public surface of the catalog module.
 * PLAN.md §2.4 — other modules import from here, never from `service.ts`
 * internals or the raw tables.
 */

export {
  listRootCategories,
  getCategoryBySlug,
  listSetsForCategory,
  groupSets,
  type CategoryCard,
  type SetCardData,
} from "./service";
