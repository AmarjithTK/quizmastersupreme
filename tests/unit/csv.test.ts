/**
 * CSV parsing/serialisation (M9).
 *
 * Backstories are multi-paragraph markdown with commas and quotes in them, so
 * quoting is the common case here, not an edge case. The formula-injection
 * guard is a security control (§16.3), not a nicety.
 */

import { describe, expect, it } from "vitest";
import { csvCell, parseCsv, rowsToObjects, toCsv } from "@/modules/questions";

describe("parseCsv", () => {
  it("splits a simple table", () => {
    expect(parseCsv("a,b,c\n1,2,3")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("keeps commas inside quoted fields", () => {
    expect(parseCsv('stem,"one, two, three",x')).toEqual([["stem", "one, two, three", "x"]]);
  });

  it("keeps NEWLINES inside quoted fields", () => {
    const csv = 'stem,backstory\n"Q?","line one\n\nline two"';
    expect(parseCsv(csv)).toEqual([
      ["stem", "backstory"],
      ["Q?", "line one\n\nline two"],
    ]);
  });

  it("unescapes doubled quotes", () => {
    expect(parseCsv('a,"he said ""hi""",b')).toEqual([["a", 'he said "hi"', "b"]]);
  });

  it("strips a UTF-8 BOM from the first header", () => {
    // Excel writes one, and it would otherwise corrupt the first column name.
    expect(parseCsv("\ufeffstem,correct\nQ,A")).toEqual([
      ["stem", "correct"],
      ["Q", "A"],
    ]);
  });

  it("handles CRLF line endings", () => {
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("drops wholly blank lines", () => {
    expect(parseCsv("a,b\n\n1,2\n\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("preserves empty fields", () => {
    expect(parseCsv("a,,c")).toEqual([["a", "", "c"]]);
  });
});

describe("csvCell — spreadsheet formula injection", () => {
  it("neutralises cells that a spreadsheet would execute", () => {
    expect(csvCell("=1+1")).toBe("'=1+1");
    expect(csvCell("+SUM(A1)")).toBe("'+SUM(A1)");
    expect(csvCell("-2+3")).toBe("'-2+3");
    expect(csvCell("@import")).toBe("'@import");
  });

  it("leaves ordinary text alone", () => {
    expect(csvCell("Which planet is largest?")).toBe("Which planet is largest?");
  });

  it("quotes and escapes separators", () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
  });

  it("renders null and undefined as empty", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });
});

describe("round trip", () => {
  it("survives toCsv → parseCsv for awkward content", () => {
    const rows = [
      ["stem", "backstory", "correct"],
      ["Has, a comma?", "Line one\n\n> quote \"and\" more\n\n| a | b |", "A"],
      ["=formula", "@mention", "B"],
    ];
    const parsed = parseCsv(toCsv(rows));

    expect(parsed).toHaveLength(3);
    expect(parsed[1]![0]).toBe("Has, a comma?");
    expect(parsed[1]![1]).toContain("Line one");
    expect(parsed[1]![1]).toContain("\n\n");
    // The formula guard survives the trip, which is why re-importing an export
    // does not silently turn text into formulas or vice versa.
    expect(parsed[2]![0]).toBe("'=formula");
  });
});

describe("rowsToObjects", () => {
  it("normalises header names", () => {
    const { records } = rowsToObjects([
      ["Stem", "Option A", "exam-body", "SOURCE_URL"],
      ["Q?", "Zephyr", "Kerala PSC", "https://example.org"],
    ]);

    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({
      stem: "Q?",
      option_a: "Zephyr",
      exam_body: "Kerala PSC",
      source_url: "https://example.org",
    });
  });

  it("fills missing trailing columns with empty strings", () => {
    const { records } = rowsToObjects([
      ["stem", "option_a", "option_b"],
      ["Q?", "one"],
    ]);
    expect(records[0]).toEqual({ stem: "Q?", option_a: "one", option_b: "" });
  });
});
