/**
 * Content option constants — the values the domain layer is allowed to accept.
 *
 * Lives in the domain (modules/catalog) so validation does not depend on UI
 * code. The UI components map these tokens to actual icon components and
 * Tailwind classes; the domain layer only ever sees the tokens.
 */

export const CATEGORY_ICONS = [
  "Atom",
  "BookOpen",
  "Brain",
  "Briefcase",
  "Calculator",
  "Cpu",
  "Dna",
  "FlaskConical",
  "Globe",
  "IndianRupee",
  "Landmark",
  "Languages",
  "Microscope",
  "Sigma",
  "Stethoscope",
  "Trophy",
] as const;
export type CategoryIconName = (typeof CATEGORY_ICONS)[number];

export const CATEGORY_ACCENTS = [
  "sky",
  "violet",
  "emerald",
  "amber",
  "rose",
  "teal",
  "lime",
  "orange",
  "indigo",
  "cyan",
] as const;
export type CategoryAccent = (typeof CATEGORY_ACCENTS)[number];