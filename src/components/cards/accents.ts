/**
 * Accent colour lookup.
 *
 * Category accent colours are stored as short tokens ("sky", "violet") in the
 * database, but Tailwind's JIT compiler cannot see class names it never finds
 * in source. So dynamic `bg-${color}-50` would silently produce no styles.
 * Every class below is written out in full, which is why this map exists.
 */

import { CATEGORY_ACCENTS } from "@/modules/catalog";

export type Accent = {
  tile: string;
  icon: string;
  hover: string;
};

const FALLBACK: Accent = {
  tile: "bg-slate-100",
  icon: "text-slate-600",
  hover: "group-hover:border-slate-300",
};

const ACCENTS: Record<string, Accent> = {
  sky: { tile: "bg-sky-50", icon: "text-sky-600", hover: "group-hover:border-sky-300" },
  violet: {
    tile: "bg-violet-50",
    icon: "text-violet-600",
    hover: "group-hover:border-violet-300",
  },
  emerald: {
    tile: "bg-emerald-50",
    icon: "text-emerald-600",
    hover: "group-hover:border-emerald-300",
  },
  amber: { tile: "bg-amber-50", icon: "text-amber-600", hover: "group-hover:border-amber-300" },
  rose: { tile: "bg-rose-50", icon: "text-rose-600", hover: "group-hover:border-rose-300" },
  teal: { tile: "bg-teal-50", icon: "text-teal-600", hover: "group-hover:border-teal-300" },
  lime: { tile: "bg-lime-50", icon: "text-lime-700", hover: "group-hover:border-lime-300" },
  orange: {
    tile: "bg-orange-50",
    icon: "text-orange-600",
    hover: "group-hover:border-orange-300",
  },
  indigo: {
    tile: "bg-indigo-50",
    icon: "text-indigo-600",
    hover: "group-hover:border-indigo-300",
  },
  cyan: { tile: "bg-cyan-50", icon: "text-cyan-600", hover: "group-hover:border-cyan-300" },
};

export function accentFor(token: string | null | undefined): Accent {
  if (!token) return FALLBACK;
  return ACCENTS[token] ?? FALLBACK;
}

export const ACCENT_TOKENS: readonly string[] = CATEGORY_ACCENTS;
