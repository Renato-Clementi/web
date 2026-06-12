/**
 * The knowledge ingestion pipeline (BAB-17).
 *
 * parse → chunk → embed (Voyage or hashing fallback) → store in
 * documents + kb_chunks, tracked by an ingestion_jobs row.
 *
 * Two entry points:
 *   - ingest(orgId, opts)            run the whole job and await it (CLI/tests)
 *   - enqueueIngestion(orgId, opts)  create the job, return its id, process in
 *                                    the background (API route — async per the
 *                                    issue's "run ingestion async" requirement)
 *
 * Async model: for v0 the background runner is in-process (a non-awaited
 * promise). That is correct for the CLI and a long-lived server; on serverless
 * (Vercel) a request may freeze after responding, so production should move the
 * runner behind a durable queue (Inngest / cron+queue, BAB-3 §5). The job
 * table and the runner signature stay the same when that swap happens.
 *
 * Idempotency: a document is keyed by (knowledge_source_id, content_hash). Re-
 * ingesting identical content skips re-embedding, so re-runs are safe.
 */
import { withOrg, toVector } from "@/lib/db";
import type {
  IngestionKind,
  IngestionResult,
  KnowledgeSourceType,
  ParsedDocument,
  RawDocument,
} from "./types";
import { parseDocument } from "./parse";
import { chunkText, type ChunkOptions } from "./chunk";
import { getEmbeddingProvider, type EmbeddingProvider } from "./embed";

export interface IngestOptions {
  kind: IngestionKind;
  source: {
    type: KnowledgeSourceType;
    name: string;
    config?: Record<string, unknown>;
  };
  /** Reuse an existing knowledge_source instead of creating one. */
  knowledgeSourceId?: string;
  documents: RawDocument[];
  chunkOptions?: ChunkOptions;
  /** Override the auto-selected embedding provider (tests). */
  embeddingProvider?: EmbeddingProvider;
}

/**
 * Create the knowledge_source (unless one was supplied) and a queued
 * ingestion_jobs row. Fast and synchronous — returns the ids the background
 * runner needs.
 */
export async function createIngestionJob(
  orgId: string,
  opts: IngestOptions,
): Promise<{ jobId: string; knowledgeSourceId: string }> {
  const providerId = (opts.embeddingProvider ?? getEmbeddingProvider().provider)
    .id;

  return withOrg(orgId, async (c) => {
    let knowledgeSourceId = opts.knowledgeSourceId;
    if (!knowledgeSourceId) {
      const src = await c.query<{ id: string }>(
        `INSERT INTO knowledge_sources (org_id, type, name, config)
         VALUES ($1, $2, $3, $4::jsonb) RETURNING id`,
        [
          orgId,
          opts.source.type,
          opts.source.name,
          JSON.stringify(opts.source.config ?? {}),
        ],
      );
      knowledgeSourceId = src.rows[0].id;
    }
    const job = await c.query<{ id: string }>(
      `INSERT INTO ingestion_jobs
         (org_id, knowledge_source_id, kind, status, total_documents, embedding_provider)
       VALUES ($1, $2, $3, 'queued', $4, $5) RETURNING id`,
      [orgId, knowledgeSourceId, opts.kind, opts.documents.length, providerId],
    );
    return { jobId: job.rows[0].id, knowledgeSourceId };
  });
}

async function setJobStatus(
  orgId: string,
  jobId: string,
  fields: Record<string, unknown>,
): Promise<void> {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const sets = keys.map((k, i) => `${k} = $${i + 3}`).join(", ");
  await withOrg(orgId, (c) =>
    c.query(`UPDATE ingestion_jobs SET ${sets} WHERE org_id = $1 AND id = $2`, [
      orgId,
      jobId,
      ...keys.map((k) => fields[k]),
    ]),
  );
}

/** Insert one parsed document and its embedded chunks (single transaction). */
async function storeDocument(
  orgId: string,
  knowledgeSourceId: string,
  parsed: ParsedDocument,
  provider: EmbeddingProvider,
  chunkOptions: ChunkOptions | undefined,
): Promise<number> {
  const chunks = chunkText(parsed.text, chunkOptions);
  if (chunks.length === 0) return 0;

  const embeddings = await provider.embed(
    chunks.map((ch) => ch.content),
    "document",
  );

  return withOrg(orgId, async (c) => {
    // Idempotency: skip a document whose content we already ingested.
    const existing = await c.query<{ id: string }>(
      `SELECT id FROM documents
       WHERE org_id = $1 AND knowledge_source_id = $2 AND content_hash = $3
       LIMIT 1`,
      [orgId, knowledgeSourceId, parsed.contentHash],
    );
    if (existing.rows.length > 0) return 0;

    const doc = await c.query<{ id: string }>(
      `INSERT INTO documents
         (org_id, knowledge_source_id, title, uri, mime_type, content_hash, content, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb) RETURNING id`,
      [
        orgId,
        knowledgeSourceId,
        parsed.title,
        parsed.uri ?? null,
        parsed.mimeType,
        parsed.contentHash,
        parsed.text,
        JSON.stringify(parsed.metadata),
      ],
    );
    const documentId = doc.rows[0].id;

    for (let i = 0; i < chunks.length; i++) {
      const ch = chunks[i];
      await c.query(
        `INSERT INTO kb_chunks
           (org_id, document_id, chunk_index, content, token_count, embedding)
         VALUES ($1, $2, $3, $4, $5, $6::vector)`,
        [
          orgId,
          documentId,
          ch.index,
          ch.content,
          ch.tokenCount,
          toVector(embeddings[i]),
        ],
      );
    }
    return chunks.length;
  });
}

/**
 * Run an already-created job to completion. Parses, chunks, embeds and stores
 * each document, updating the job row as it goes. Never throws: failures are
 * recorded on the job (status = 'failed', error set) and returned.
 */
export async function runIngestionJob(
  orgId: string,
  jobId: string,
  knowledgeSourceId: string,
  documents: RawDocument[],
  opts: {
    chunkOptions?: ChunkOptions;
    embeddingProvider?: EmbeddingProvider;
  } = {},
): Promise<IngestionResult> {
  const provider = opts.embeddingProvider ?? getEmbeddingProvider().provider;
  let processed = 0;
  let totalChunks = 0;

  await setJobStatus(orgId, jobId, {
    status: "running",
    started_at: new Date(),
    embedding_provider: provider.id,
  });

  try {
    for (const raw of documents) {
      const parsed = parseDocument(raw);
      const stored = await storeDocument(
        orgId,
        knowledgeSourceId,
        parsed,
        provider,
        opts.chunkOptions,
      );
      processed += 1;
      totalChunks += stored;
      await setJobStatus(orgId, jobId, {
        processed_documents: processed,
        total_chunks: totalChunks,
        embedded_chunks: totalChunks,
      });
    }

    await setJobStatus(orgId, jobId, {
      status: "succeeded",
      finished_at: new Date(),
    });

    // Stamp the source as synced.
    await withOrg(orgId, (c) =>
      c.query(
        `UPDATE knowledge_sources SET last_synced_at = now()
         WHERE org_id = $1 AND id = $2`,
        [orgId, knowledgeSourceId],
      ),
    );

    return {
      jobId,
      status: "succeeded",
      totalDocuments: documents.length,
      processedDocuments: processed,
      totalChunks,
      embeddedChunks: totalChunks,
      embeddingProvider: provider.id,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await setJobStatus(orgId, jobId, {
      status: "failed",
      finished_at: new Date(),
      error: message,
      processed_documents: processed,
      total_chunks: totalChunks,
      embedded_chunks: totalChunks,
    });
    return {
      jobId,
      status: "failed",
      totalDocuments: documents.length,
      processedDocuments: processed,
      totalChunks,
      embeddedChunks: totalChunks,
      embeddingProvider: provider.id,
      error: message,
    };
  }
}

/** Create + run a job, awaited. For the CLI and tests. */
export async function ingest(
  orgId: string,
  opts: IngestOptions,
): Promise<IngestionResult> {
  const { jobId, knowledgeSourceId } = await createIngestionJob(orgId, opts);
  return runIngestionJob(orgId, jobId, knowledgeSourceId, opts.documents, {
    chunkOptions: opts.chunkOptions,
    embeddingProvider: opts.embeddingProvider,
  });
}

/**
 * Create a job, return its id immediately, and process it in the background.
 * For the API route. See the file header on the serverless caveat.
 */
export async function enqueueIngestion(
  orgId: string,
  opts: IngestOptions,
): Promise<{ jobId: string; knowledgeSourceId: string }> {
  const ids = await createIngestionJob(orgId, opts);
  // Fire-and-forget: do not await. Swallow errors (they are recorded on the
  // job row by runIngestionJob itself).
  void runIngestionJob(
    orgId,
    ids.jobId,
    ids.knowledgeSourceId,
    opts.documents,
    {
      chunkOptions: opts.chunkOptions,
      embeddingProvider: opts.embeddingProvider,
    },
  );
  return ids;
}
