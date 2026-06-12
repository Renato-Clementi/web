/**
 * Minimal RFC-4180 CSV parser (dependency-free).
 *
 * Handles the cases that matter for real ticket exports: quoted fields,
 * embedded commas, embedded newlines inside quotes, and doubled "" escapes.
 * Returns an array of row objects keyed by the (trimmed) header names.
 *
 * Not a streaming parser — ticket CSV exports for an SMB knowledge base fit
 * comfortably in memory. If we later ingest very large exports, swap this for
 * a streaming library; callers only depend on the row-object shape.
 */

/** Parse CSV text into an array of string-cell rows (header included). */
export function parseCsvRows(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const text = input.replace(/^﻿/, ""); // strip BOM
  const n = text.length;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      endField();
      i++;
      continue;
    }
    if (c === "\n" || c === "\r") {
      // Consume \r\n as a single line break.
      if (c === "\r" && text[i + 1] === "\n") i++;
      endRow();
      i++;
      continue;
    }
    field += c;
    i++;
  }
  // Flush trailing field/row unless the input ended exactly on a newline.
  if (field.length > 0 || row.length > 0) endRow();

  return rows;
}

/**
 * Parse CSV into row objects keyed by header. Blank trailing rows are dropped.
 * Header keys are trimmed; duplicate headers keep the last occurrence.
 */
export function parseCsv(input: string): Record<string, string>[] {
  const rows = parseCsvRows(input);
  if (rows.length === 0) return [];
  const headers = rows[0].map((h) => h.trim());
  const out: Record<string, string>[] = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    // Skip fully empty rows (e.g. a trailing newline).
    if (cells.length === 1 && cells[0].trim() === "") continue;
    const obj: Record<string, string> = {};
    headers.forEach((h, idx) => {
      obj[h] = (cells[idx] ?? "").trim();
    });
    out.push(obj);
  }
  return out;
}
