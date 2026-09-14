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

export const ICON_NAMES = Object.keys(ICONS).sort();

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
