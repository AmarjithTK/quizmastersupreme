"use client";

/**
 * A timestamp rendered in the VIEWER's timezone, without a hydration mismatch.
 *
 * Why this exists: a client component is server-rendered too, so calling
 * `new Date(ts).toLocaleString()` during render produced one string on the
 * server (Workers run in UTC) and another in the browser (local time). React
 * then failed hydration with "server rendered text didn't match the client".
 *
 * The fix is to render a DETERMINISTIC string (locale + UTC pinned) until the
 * component has mounted, then swap to the viewer's local time. The first client
 * render therefore matches the SSR HTML exactly, and the update happens after
 * hydration.
 *
 * `suppressHydrationWarning` covers the residual case where the server's ICU
 * data formats a pinned locale slightly differently from the browser's.
 */

import { useEffect, useState } from "react";

const DEFAULT_OPTIONS: Intl.DateTimeFormatOptions = {
  dateStyle: "short",
  timeStyle: "short",
};

function format(value: number | string | Date, options: Intl.DateTimeFormatOptions): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-IN", options).format(date);
}

export function LocalTime({
  value,
  options,
  className,
}: {
  value: number | string | Date;
  /** Defaults to a short date + time. */
  options?: Intl.DateTimeFormatOptions;
  className?: string;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const date = value instanceof Date ? value : new Date(value);
  const opts = options ?? DEFAULT_OPTIONS;
  const iso = Number.isNaN(date.getTime()) ? undefined : date.toISOString();

  return (
    <time
      dateTime={iso}
      title={iso}
      className={className}
      suppressHydrationWarning
    >
      {/* SSR + first client render: pinned to UTC so both sides agree. */}
      {mounted ? format(date, opts) : format(date, { ...opts, timeZone: "UTC" })}
    </time>
  );
}

export default LocalTime;
