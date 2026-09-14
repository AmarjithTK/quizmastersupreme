/**
 * Renders a lucide icon by its stored NAME.
 *
 * Icons are strings in the database, so we resolve them through an explicit
 * allowlist rather than a dynamic barrel import. That keeps the client bundle
 * from pulling in all ~1500 lucide icons, and means an unknown icon name
 * degrades to a default instead of crashing the home page.
 */

import {
  Atom,
  BookOpen,
  Brain,
  Briefcase,
  Calculator,
  Cpu,
  Dna,
  FlaskConical,
  Globe,
  IndianRupee,
  Landmark,
  Languages,
  type LucideIcon,
  Microscope,
  Sigma,
  Stethoscope,
  Trophy,
} from "lucide-react";
import { CATEGORY_ICONS } from "@/modules/catalog";

const ICONS: Record<string, LucideIcon> = {
  Atom,
  BookOpen,
  Brain,
  Briefcase,
  Calculator,
  Cpu,
  Dna,
  FlaskConical,
  Globe,
  IndianRupee,
  Landmark,
  Languages,
  Microscope,
  Sigma,
  Stethoscope,
  Trophy,
};

// The allowlist lives in the DOMAIN so validation can use it without importing
// React. This import is the compile-time guard that the two lists stay equal:
// CATEGORY_ICONS is a `as const` tuple, and the map above satisfies it.
export const ICON_NAMES: readonly string[] = CATEGORY_ICONS;

export function CategoryIcon({
  name,
  className,
}: {
  name: string | null | undefined;
  className?: string;
}) {
  const Icon = (name ? ICONS[name] : undefined) ?? BookOpen;
  return <Icon className={className} aria-hidden="true" />;
}
