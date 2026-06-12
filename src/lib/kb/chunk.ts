/**
 * Chunking for the ingestion pipeline (BAB-17).
 *
 * We split parsed text into windows sized for the embedding model, preferring
 * natural boundaries (paragraphs, then sentences) so a chunk rarely cuts a
 * thought in half. Adjacent chunks overlap by a small amount so a fact that
 * straddles a boundary is still retrievable from at least one chunk.
 *
 * Token counting: we avoid pulling in a tokenizer dependency and estimate
 * tokens as ceil(chars / 4) — the standard rough rule for English-ish text.
 * Embedding providers enforce their own real token limits; this estimate only
 * drives chunk *sizing*, so being approximate is fine.
 */
import type { Chunk } from "./types";

export interface ChunkOptions {
  /** Target chunk size in (estimated) tokens. */
  targetTokens?: number;
  /** Overlap between consecutive chunks, in (estimated) tokens. */
  overlapTokens?: number;
  /** Drop chunks shorter than this many characters (noise). */
  minChars?: number;
}

const DEFAULTS: Required<ChunkOptions> = {
  targetTokens: 512,
  overlapTokens: 64,
  minChars: 12,
};

/** Rough token estimate — see file header. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Split into paragraphs on blank lines, keeping non-empty blocks. */
function splitParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/** Split an oversized paragraph into sentences (keeps the delimiter). */
function splitSentences(text: string): string[] {
  const parts = text.match(/[^.!?\n]+[.!?]*\s*|\S+\s*/g);
  return parts ? parts.map((s) => s.trim()).filter(Boolean) : [text];
}

/**
 * Hard-split a single unit (e.g. a giant sentence or unbroken token run) that
 * exceeds the target on its own, by character budget.
 */
function hardSplit(text: string, maxChars: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += maxChars) {
    out.push(text.slice(i, i + maxChars));
  }
  return out;
}

/**
 * Chunk parsed text into overlapping windows. Deterministic and pure — same
 * input always yields the same chunks (important for re-ingest dedupe and for
 * the smoke test's assertions).
 */
export function chunkText(text: string, options: ChunkOptions = {}): Chunk[] {
  const { targetTokens, overlapTokens, minChars } = { ...DEFAULTS, ...options };
  const maxChars = targetTokens * 4;
  const overlapChars = overlapTokens * 4;

  const clean = text.trim();
  if (clean.length === 0) return [];

  // Build a list of atomic units no larger than the target, preserving order.
  const units: string[] = [];
  for (const para of splitParagraphs(clean)) {
    if (para.length <= maxChars) {
      units.push(para);
      continue;
    }
    for (const sentence of splitSentences(para)) {
      if (sentence.length <= maxChars) units.push(sentence);
      else units.push(...hardSplit(sentence, maxChars));
    }
  }

  // Greedily pack units into windows up to maxChars; carry overlap forward.
  const chunks: Chunk[] = [];
  let buf = "";
  let index = 0;

  const flush = () => {
    const content = buf.trim();
    if (content.length >= minChars) {
      chunks.push({ index, content, tokenCount: estimateTokens(content) });
      index++;
    }
  };

  for (const unit of units) {
    if (buf.length === 0) {
      buf = unit;
    } else if (buf.length + 1 + unit.length <= maxChars) {
      buf += `\n\n${unit}`;
    } else {
      flush();
      // Start the next window with a tail of the previous one for overlap.
      const tail = overlapChars > 0 ? buf.slice(-overlapChars) : "";
      buf = tail ? `${tail.trim()}\n\n${unit}` : unit;
      // Guard against overlap making the new window exceed maxChars.
      if (buf.length > maxChars) buf = unit;
    }
  }
  if (buf.trim().length > 0) flush();

  return chunks;
}
