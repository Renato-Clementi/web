/**
 * Shared types for the knowledge ingestion pipeline (BAB-17).
 *
 * Flow: RawInput → parse → ParsedDocument → chunk → Chunk[] → embed →
 * EmbeddedChunk[] → store in documents + kb_chunks.
 */

/** A knowledge source kind, mirroring knowledge_sources.type in the schema. */
export type KnowledgeSourceType =
  | "help_center"
  | "website"
  | "file_upload"
  | "ticket_import"
  | "manual";

/** What an ingestion job is processing. Mirrors ingestion_jobs.kind. */
export type IngestionKind = "docs" | "tickets";

export type IngestionStatus = "queued" | "running" | "succeeded" | "failed";

/**
 * One raw input unit handed to the pipeline before parsing — a help-center
 * document (its body, possibly HTML/markdown) or a single imported ticket.
 */
export interface RawDocument {
  /** Human title; falls back to a derived one when absent. */
  title?: string;
  /** Origin URL or path, stored on documents.uri for source attribution. */
  uri?: string;
  /** MIME type (e.g. text/html, text/markdown). Drives parser selection. */
  mimeType?: string;
  /** Raw content to parse. */
  content: string;
  /** Free-form metadata merged onto documents.metadata. */
  metadata?: Record<string, unknown>;
}

/** A document after parsing: clean, embeddable plain text + a title. */
export interface ParsedDocument {
  title: string;
  uri?: string;
  mimeType: string;
  /** Plain-text body, ready to chunk. */
  text: string;
  /** Stable hash of the parsed text — used to skip re-embedding unchanged docs. */
  contentHash: string;
  metadata: Record<string, unknown>;
}

/** A slice of a parsed document targeted at the embedding model's window. */
export interface Chunk {
  index: number;
  content: string;
  /** Estimated token count (see chunk.ts for the heuristic). */
  tokenCount: number;
}

/** A chunk with its embedding vector attached. */
export interface EmbeddedChunk extends Chunk {
  embedding: number[];
}

/** Result of running a full ingestion job. */
export interface IngestionResult {
  jobId: string;
  status: IngestionStatus;
  totalDocuments: number;
  processedDocuments: number;
  totalChunks: number;
  embeddedChunks: number;
  embeddingProvider: string;
  error?: string;
}

/** A retrieved chunk with the source references needed for citations. */
export interface RetrievedChunk {
  chunkId: string;
  documentId: string;
  chunkIndex: number;
  content: string;
  /** Cosine similarity in [0, 1] (1 = identical direction). */
  score: number;
  source: {
    documentTitle: string | null;
    documentUri: string | null;
    knowledgeSourceId: string;
    knowledgeSourceName: string | null;
    knowledgeSourceType: string | null;
  };
}
