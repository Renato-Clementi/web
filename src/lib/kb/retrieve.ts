/**
 * Retrieval over the embedded knowledge base (BAB-17 acceptance; the seam the
 * BAB-18 answer engine builds on).
 *
 * Embeds the query with the SAME provider used at ingestion, then runs a
 * cosine nearest-neighbour search over kb_chunks (HNSW index, `<=>` operator),
 * scoped to the org by RLS. Returns chunks with the source references needed
 * for citations (document title/uri + knowledge source).
 */
import { withOrg, toVector } from "@/lib/db";
import { getEmbeddingProvider, type EmbeddingProvider } from "./embed";
import type { RetrievedChunk } from "./types";

export interface RetrieveOptions {
  limit?: number;
  /** Drop results whose cosine similarity is below this threshold (0..1). */
  minScore?: number;
  embeddingProvider?: EmbeddingProvider;
}

interface Row {
  chunk_id: string;
  document_id: string;
  chunk_index: number;
  content: string;
  distance: string; // pg numeric comes back as string
  document_title: string | null;
  document_uri: string | null;
  knowledge_source_id: string;
  knowledge_source_name: string | null;
  knowledge_source_type: string | null;
}

/**
 * Retrieve the most relevant chunks for `queryText` within `orgId`.
 * Cosine distance d = 1 - cosine_similarity for normalized vectors, so
 * similarity = 1 - d.
 */
export async function retrieveChunks(
  orgId: string,
  queryText: string,
  options: RetrieveOptions = {},
): Promise<RetrievedChunk[]> {
  const limit = Math.max(1, Math.min(options.limit ?? 5, 50));
  const minScore = options.minScore ?? 0;
  const provider = options.embeddingProvider ?? getEmbeddingProvider().provider;

  const [embedding] = await provider.embed([queryText], "query");
  const queryVec = toVector(embedding);

  const rows = await withOrg(orgId, async (c) => {
    const r = await c.query<Row>(
      `SELECT
         kc.id            AS chunk_id,
         kc.document_id   AS document_id,
         kc.chunk_index   AS chunk_index,
         kc.content       AS content,
         (kc.embedding <=> $1::vector) AS distance,
         d.title          AS document_title,
         d.uri            AS document_uri,
         ks.id            AS knowledge_source_id,
         ks.name          AS knowledge_source_name,
         ks.type          AS knowledge_source_type
       FROM kb_chunks kc
       JOIN documents d ON d.org_id = kc.org_id AND d.id = kc.document_id
       JOIN knowledge_sources ks
         ON ks.org_id = d.org_id AND ks.id = d.knowledge_source_id
       WHERE kc.embedding IS NOT NULL
       ORDER BY kc.embedding <=> $1::vector
       LIMIT $2`,
      [queryVec, limit],
    );
    return r.rows;
  });

  return rows
    .map((row) => ({
      chunkId: row.chunk_id,
      documentId: row.document_id,
      chunkIndex: row.chunk_index,
      content: row.content,
      score: 1 - Number(row.distance),
      source: {
        documentTitle: row.document_title,
        documentUri: row.document_uri,
        knowledgeSourceId: row.knowledge_source_id,
        knowledgeSourceName: row.knowledge_source_name,
        knowledgeSourceType: row.knowledge_source_type,
      },
    }))
    .filter((r) => r.score >= minScore);
}
