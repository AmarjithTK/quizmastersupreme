/**
 * Attempt state machine. PLAN.md §11.2.
 *
 * Allowed transitions only — there is no "un-complete" and no "un-abandon".
 * Any other transition is a conflict, not a silent no-op, because a silent
 * no-op here would mean an answer being quietly written into a finished paper.
 */

import { conflict } from "@/lib/errors";
import type { AttemptStatus } from "@/db/schema";

const TRANSITIONS: Record<AttemptStatus, readonly AttemptStatus[]> = {
  in_progress: ["completed", "abandoned", "expired"],
  completed: [],
  abandoned: [],
  expired: [],
};

export function canTransition(from: AttemptStatus, to: AttemptStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: AttemptStatus, to: AttemptStatus): void {
  if (from === to) return;
  if (!canTransition(from, to)) {
    throw conflict(`An attempt cannot move from "${from}" to "${to}".`);
  }
}

export function isTerminal(status: AttemptStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

export function isWritable(status: AttemptStatus): boolean {
  return status === "in_progress";
}
