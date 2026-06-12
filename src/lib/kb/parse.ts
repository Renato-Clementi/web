/**
 * Document parsing for the ingestion pipeline (BAB-17).
 *
 * Per BAB-3 plan §5 we "start with libraries" and only escalate to a paid
 * parser (LlamaParse/Unstructured) when quality demands. For the v0 scope —
 * help-center docs (HTML/markdown/plain text) and CSV ticket exports — the
 * formats are text-native, so we keep zero runtime dependencies and hand-roll
 * small, well-tested parsers (the same self-contained ethos as the Odoo client
 * and the migration runner).
 *
 * Binary office formats (PDF / docx / xlsx) are intentionally NOT handled here.
 * They are a registered escalation seam: `parseDocument` throws a clear error
 * naming the missing parser, and adding one is a localized change to the
 * `PARSERS` registry below (drop in `pdf-parse` / `mammoth` / `xlsx`).
 */
import { createHash } from "node:crypto";
import type { ParsedDocument, RawDocument } from "./types";
import { htmlToText } from "./html";

/** Stable content hash (sha256, hex) used to dedupe unchanged documents. */
export function hashContent(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Collapse runs of blank lines / trailing whitespace into a tidy body. */
function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Strip the lightweight markdown syntax that adds no retrieval signal while
 * keeping the words. We deliberately keep it conservative — headings, emphasis,
 * list bullets, link text (drop the URL), inline/code fences — rather than
 * pulling in a full markdown AST. Link text is retained because it carries
 * meaning; the destination URL does not.
 */
function markdownToText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, (block) =>
      block.replace(/```[^\n]*\n?|```/g, ""),
    )
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // images → drop
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links → keep text
    .replace(/^\s{0,3}#{1,6}\s+/gm, "") // ATX headings
    .replace(/^\s{0,3}>\s?/gm, "") // blockquotes
    .replace(/^\s*[-*+]\s+/gm, "") // bullets
    .replace(/^\s*\d+\.\s+/gm, "") // ordered list markers
    .replace(/(\*\*|__)(.*?)\1/g, "$2") // bold
    .replace(/(\*|_)(.*?)\1/g, "$2") // italic
    .replace(/^\s*([-*_]\s*){3,}$/gm, ""); // horizontal rules
}

/** Derive a title from the first non-empty line when none was supplied. */
function deriveTitle(text: string): string {
  const firstLine = text.split("\n").find((l) => l.trim().length > 0);
  if (!firstLine) return "Untitled document";
  const trimmed = firstLine.trim();
  return trimmed.length > 120 ? `${trimmed.slice(0, 117)}…` : trimmed;
}

/**
 * Resolve a parser key from an explicit MIME type, falling back to the URI's
 * file extension, then to plain text.
 */
function resolveFormat(raw: RawDocument): "html" | "markdown" | "text" {
  const mime = raw.mimeType?.toLowerCase() ?? "";
  if (mime.includes("html")) return "html";
  if (mime.includes("markdown")) return "markdown";
  if (mime.includes("text/plain")) return "text";

  const uri = raw.uri?.toLowerCase() ?? "";
  if (/\.(html?|xhtml)$/.test(uri)) return "html";
  if (/\.(md|markdown|mdx)$/.test(uri)) return "markdown";

  // Unknown text: if it smells like HTML, treat it as HTML; else plain text.
  if (/<\/?[a-z][\s\S]*>/i.test(raw.content)) return "html";
  return "text";
}

const UNSUPPORTED_BINARY = /\.(pdf|docx?|xlsx?|pptx?)$/i;

/**
 * Parse a raw input into clean, embeddable plain text + a title and a content
 * hash. Throws for binary office formats we have not wired a parser for yet.
 */
export function parseDocument(raw: RawDocument): ParsedDocument {
  const mime = raw.mimeType?.toLowerCase() ?? "";
  if (
    UNSUPPORTED_BINARY.test(raw.uri ?? "") ||
    /pdf|officedocument|msword|ms-excel/.test(mime)
  ) {
    throw new Error(
      `No parser registered for "${raw.uri ?? raw.mimeType}". ` +
        `Binary office formats (PDF/docx/xlsx) are a future escalation ` +
        `(BAB-3 §5: add pdf-parse/mammoth/xlsx to src/lib/kb/parse.ts).`,
    );
  }

  const format = resolveFormat(raw);
  let text: string;
  switch (format) {
    case "html":
      text = htmlToText(raw.content);
      break;
    case "markdown":
      text = markdownToText(raw.content);
      break;
    default:
      text = raw.content;
  }
  text = normalizeText(text);

  const title = raw.title?.trim() || deriveTitle(text);
  return {
    title,
    uri: raw.uri,
    mimeType: raw.mimeType ?? `text/${format === "text" ? "plain" : format}`,
    text,
    contentHash: hashContent(text),
    metadata: raw.metadata ?? {},
  };
}
