/**
 * Turn a past-tickets CSV export into RawDocuments for the pipeline (BAB-17).
 *
 * Ticket exports vary wildly by helpdesk, so we auto-detect the common column
 * names (case-insensitive) and let the caller override the mapping. Each
 * resolved ticket becomes ONE document: subject + the customer's question +
 * the resolution, so a future retrieval can surface "here's how this was
 * answered before".
 *
 * Scope (per the issue): import PAST RESOLVED tickets. When a status column is
 * present we keep only rows that look resolved/closed/solved; with no status
 * column we keep everything and trust the export to be pre-filtered.
 */
import { parseCsv } from "./csv";
import type { RawDocument } from "./types";

export interface TicketColumnMapping {
  id?: string[];
  subject?: string[];
  question?: string[];
  resolution?: string[];
  status?: string[];
}

const DEFAULTS: Required<TicketColumnMapping> = {
  id: ["id", "ticket_id", "ticket id", "ticket #", "number", "ref", "case_id"],
  subject: ["subject", "title", "summary", "topic"],
  question: [
    "description",
    "body",
    "question",
    "message",
    "request",
    "customer_message",
    "inquiry",
  ],
  resolution: [
    "resolution",
    "answer",
    "solution",
    "reply",
    "response",
    "resolution_note",
    "comment",
  ],
  status: ["status", "state", "ticket_status"],
};

const RESOLVED_VALUES = new Set([
  "resolved",
  "closed",
  "solved",
  "done",
  "complete",
  "completed",
  "answered",
]);

/** Find the actual header that matches one of the candidate names. */
function pickColumn(
  headers: string[],
  candidates: string[],
): string | undefined {
  const lower = new Map(headers.map((h) => [h.toLowerCase(), h]));
  for (const cand of candidates) {
    const hit = lower.get(cand.toLowerCase());
    if (hit) return hit;
  }
  return undefined;
}

export interface TicketImportResult {
  documents: RawDocument[];
  /** Rows skipped because they were not resolved. */
  skippedUnresolved: number;
  /** Rows skipped because they had no usable text. */
  skippedEmpty: number;
}

/**
 * Parse a tickets CSV into RawDocuments. `mapping` overrides the auto-detected
 * column candidates per field.
 */
export function ticketsCsvToDocuments(
  csv: string,
  mapping: TicketColumnMapping = {},
): TicketImportResult {
  const rows = parseCsv(csv);
  if (rows.length === 0) {
    return { documents: [], skippedUnresolved: 0, skippedEmpty: 0 };
  }
  const headers = Object.keys(rows[0]);
  const col = {
    id: pickColumn(headers, mapping.id ?? DEFAULTS.id),
    subject: pickColumn(headers, mapping.subject ?? DEFAULTS.subject),
    question: pickColumn(headers, mapping.question ?? DEFAULTS.question),
    resolution: pickColumn(headers, mapping.resolution ?? DEFAULTS.resolution),
    status: pickColumn(headers, mapping.status ?? DEFAULTS.status),
  };

  const documents: RawDocument[] = [];
  let skippedUnresolved = 0;
  let skippedEmpty = 0;

  rows.forEach((r, idx) => {
    if (col.status) {
      const status = (r[col.status] ?? "").toLowerCase().trim();
      if (status && !RESOLVED_VALUES.has(status)) {
        skippedUnresolved++;
        return;
      }
    }

    const subject = col.subject ? r[col.subject]?.trim() : "";
    const question = col.question ? r[col.question]?.trim() : "";
    const resolution = col.resolution ? r[col.resolution]?.trim() : "";

    // A ticket is only useful as knowledge if it has a question and/or answer.
    if (!question && !resolution && !subject) {
      skippedEmpty++;
      return;
    }

    const ticketId = col.id ? r[col.id]?.trim() : "";
    const parts: string[] = [];
    if (question) parts.push(`Question:\n${question}`);
    if (resolution) parts.push(`Resolution:\n${resolution}`);
    const content = parts.join("\n\n") || subject;

    documents.push({
      title: subject || (ticketId ? `Ticket ${ticketId}` : `Ticket ${idx + 1}`),
      uri: ticketId ? `ticket:${ticketId}` : undefined,
      mimeType: "text/plain",
      content,
      metadata: {
        kind: "ticket",
        ticketId: ticketId || undefined,
        ...(col.status ? { status: r[col.status] } : {}),
      },
    });
  });

  return { documents, skippedUnresolved, skippedEmpty };
}
