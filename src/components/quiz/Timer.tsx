"use client";

/**
 * Countdown for a timed attempt.
 *
 * The client clock is DISPLAY ONLY. Remaining time is recomputed from the
 * server-provided deadline on every tick (rather than decremented), so a
 * throttled background tab cannot drift, and the submission itself is validated
 * server-side regardless (§11.5).
 *
 * Rendered only after mount: the server and client would otherwise disagree by
 * a second and produce a hydration mismatch.
 */

import { Clock } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn, formatClock } from "@/lib/utils";

export function Elapsed({
  since,
  className,
}: {
  /** Epoch ms the attempt started. */
  since: number;
  className?: string;
}) {
  const [mounted, setMounted] = useState(false);
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    setMounted(true);
    const tick = () => setSeconds(Math.max(0, Math.floor((Date.now() - since) / 1000)));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [since]);

  return (
    <span
      className={cn("inline-flex items-center gap-1.5 font-mono text-sm tabular-nums text-slate-700", className)}
    >
      <Clock className="size-4" />
      {mounted ? formatClock(seconds) : "--:--"}
    </span>
  );
}

export function Timer({
  deadlineAt,
  onExpire,
  className,
}: {
  deadlineAt: number | null;
  onExpire: () => void;
  className?: string;
}) {
  const [mounted, setMounted] = useState(false);
  const [remaining, setRemaining] = useState<number | null>(null);

  // Keep the callback in a ref so the interval effect never re-subscribes.
  const onExpireRef = useRef(onExpire);
  onExpireRef.current = onExpire;
  const firedRef = useRef(false);

  useEffect(() => {
    setMounted(true);
    if (deadlineAt == null) return;

    const tick = () => {
      const left = Math.max(0, Math.floor((deadlineAt - Date.now()) / 1000));
      setRemaining(left);
      if (left <= 0 && !firedRef.current) {
        firedRef.current = true;
        onExpireRef.current();
      }
    };

    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [deadlineAt]);

  if (deadlineAt == null) {
    return (
      <span className={cn("text-xs text-slate-400", className)} title="This set is not timed">
        Untimed
      </span>
    );
  }

  const urgent = remaining !== null && remaining <= 60;
  const expired = remaining !== null && remaining <= 0;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 font-mono text-sm tabular-nums",
        expired ? "text-red-600" : urgent ? "text-amber-600" : "text-slate-700",
        className,
      )}
      role="timer"
      aria-live={urgent ? "polite" : "off"}
    >
      <Clock className="size-4" />
      {mounted && remaining !== null ? formatClock(remaining) : "--:--"}
    </span>
  );
}
