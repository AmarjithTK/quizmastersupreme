/**
 * CSV parsing and serialisation for the question bank (M9).
 *
 * Hand-written rather than pulled from a package because the two things that
 * actually bite here are both security/correctness details a naive library
 * split on `,` gets wrong:
 *
 *   1. Quoted fields containing commas, quotes and NEWLINES. Backstories are
 *      multi-paragraph markdown, so this is the common case, not the edge case.
 *   2. Spreadsheet formula injection. A cell beginning with `=`, `+`, `-` or `@`
 *      is executed as a formula when the export is opened in Excel or Sheets,
 *      so exported cells are prefixed with an apostrophe (§16.3).
 */

/** Characters a spreadsheet treats as the start of a formula. */
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

export function parseCsv(input: string): string[][] {
  let text = input;
  // Strip a UTF-8 BOM, which Excel adds and which would corrupt the first header.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i]!;

    if (inQuotes) {
      if (ch === '"') {
        // A doubled quote inside a quoted field is a literal quote.
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (ch === "\r") {
      i++;
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    field += ch;
    i++;
  }

  row.push(field);
  rows.push(row);

  // Drop wholly blank lines (a trailing newline produces one).
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

export function csvCell(value: unknown): string {
  const raw = value == null ? "" : String(value);
  const guarded = FORMULA_PREFIX.test(raw) ? `'${raw}` : raw;
  return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

export function toCsv(rows: readonly unknown[][]): string {
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}

/**
 * Map a header row + data rows onto objects keyed by normalised header name.
 *
 * Header names are lowercased with spaces/dashes turned into underscores, so
 * "Exam Body", "exam-body" and "exam_body" all work.
 */
export function rowsToObjects(rows: string[][]): {
  headers: string[];
  records: Array<Record<string, string>>;
} {
  const [headerRow = [], ...dataRows] = rows;
  const headers = headerRow.map((h) => h.trim().toLowerCase().replace(/[\s-]+/g, "_"));

  const records = dataRows.map((row) => {
    const record: Record<string, string> = {};
    for (const [index, header] of headers.entries()) {
      record[header] = (row[index] ?? "").trim();
    }
    return record;
  });

  return { headers, records };
}
