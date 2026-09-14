/**
 * LocalTime — the hydration-mismatch fix.
 *
 * A client component is server-rendered too, so formatting a timestamp with
 * `toLocaleString()` in render produced a UTC string on the server and a local
 * string in the browser, which broke hydration on the admin generate screen.
 *
 * The contract this file locks: the SERVER-rendered (and therefore the first
 * client) render is timezone-pinned to UTC, and the element carries a
 * machine-readable `dateTime`.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LocalTime } from "@/components/ui/LocalTime";

// 2026-09-14T21:03:00Z — the exact case from the bug report: it renders as
// "14/09/26, 9:03 pm" in UTC and "15/09/26, 2:33 am" in Asia/Kolkata.
const TS = Date.UTC(2026, 8, 14, 21, 3, 0);

const utcExpected = (options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat("en-IN", { ...options, timeZone: "UTC" }).format(new Date(TS));

describe("LocalTime", () => {
  it("server-renders a UTC-pinned string, so SSR and the first client render agree", () => {
    const html = renderToStaticMarkup(<LocalTime value={TS} />);

    expect(html).toContain(utcExpected({ dateStyle: "short", timeStyle: "short" }));
    // Same instant, pinned timezone — NOT the viewer's local rendering.
    expect(html).not.toContain(
      new Intl.DateTimeFormat("en-IN", {
        dateStyle: "short",
        timeStyle: "short",
      }).format(new Date(TS)),
    );
  });

  it("exposes the instant machine-readably", () => {
    const html = renderToStaticMarkup(<LocalTime value={TS} />);
    expect(html).toContain(`dateTime="${new Date(TS).toISOString()}"`);
    expect(html).toContain(`title="${new Date(TS).toISOString()}"`);
  });

  it("honours custom format options while still pinning the timezone", () => {
    const html = renderToStaticMarkup(
      <LocalTime value={TS} options={{ year: "numeric", month: "long", day: "numeric" }} />,
    );
    expect(html).toContain(
      utcExpected({ year: "numeric", month: "long", day: "numeric" }),
    );
  });

  it("accepts ISO strings and Date objects", () => {
    const fromString = renderToStaticMarkup(<LocalTime value={new Date(TS).toISOString()} />);
    const fromDate = renderToStaticMarkup(<LocalTime value={new Date(TS)} />);
    expect(fromString).toBe(fromDate);
  });

  it("renders a dash for an unusable value instead of throwing", () => {
    const html = renderToStaticMarkup(<LocalTime value="not a date" />);
    expect(html).toContain("—");
    expect(html).not.toContain("dateTime=");
  });
});
