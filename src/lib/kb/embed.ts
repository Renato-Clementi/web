/**
 * Embeddings for the ingestion pipeline (BAB-17).
 *
 * Two providers behind one interface, mirroring the repo's existing live/demo
 * fallback pattern (see src/lib/leads/source.ts):
 *
 *   1. VoyageEmbeddingProvider — the real, high-quality semantic embeddings
 *      (BAB-3 §5: Voyage `voyage-3`, 1024-dim → matches kb_chunks.vector(1024)).
 *      Used when VOYAGE_API_KEY is set.
 *
 *   2. HashEmbeddingProvider — a deterministic, dependency-free feature-hashing
 *      bag-of-words embedding. NOT semantic, but it IS lexically meaningful:
 *      chunks that share words land near a query that shares those words. This
 *      lets the whole pipeline — including the retrieval acceptance test — run
 *      in CI and locally with NO secret, while production gets Voyage quality
 *      by simply setting the key. Both emit L2-normalized 1024-dim vectors, so
 *      cosine distance (the kb_chunks HNSW index) behaves consistently.
 *
 * The SAME provider must embed both documents and queries, so the answer
 * engine (BAB-18) imports getEmbeddingProvider() rather than re-deciding.
 */
import { EMBEDDING_DIMENSIONS } from "@/lib/db";

export type EmbeddingInputType = "document" | "query";

export interface EmbeddingProvider {
  /** Stable id stored on ingestion_jobs.embedding_provider for traceability. */
  readonly id: string;
  readonly dimensions: number;
  embed(texts: string[], inputType: EmbeddingInputType): Promise<number[][]>;
}

// --- Voyage ----------------------------------------------------------------

const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";
/** Voyage accepts up to 128 inputs per request. */
const VOYAGE_BATCH = 128;

interface VoyageResponse {
  data: { embedding: number[]; index: number }[];
}

export class VoyageEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  readonly dimensions = EMBEDDING_DIMENSIONS;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(opts: { apiKey: string; model?: string; timeoutMs?: number }) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? process.env.VOYAGE_MODEL ?? "voyage-3";
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.id = `voyage:${this.model}`;
  }

  async embed(
    texts: string[],
    inputType: EmbeddingInputType,
  ): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += VOYAGE_BATCH) {
      const batch = texts.slice(i, i + VOYAGE_BATCH);
      out.push(...(await this.embedBatch(batch, inputType)));
    }
    return out;
  }

  private async embedBatch(
    batch: string[],
    inputType: EmbeddingInputType,
  ): Promise<number[][]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(VOYAGE_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          input: batch,
          model: this.model,
          input_type: inputType,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(
          `Voyage embeddings request failed (${res.status}): ${body.slice(0, 300)}`,
        );
      }
      const json = (await res.json()) as VoyageResponse;
      // Order by index defensively, then normalize for cosine consistency.
      return json.data
        .slice()
        .sort((a, b) => a.index - b.index)
        .map((d) => normalize(d.embedding));
    } finally {
      clearTimeout(timer);
    }
  }
}

// --- Deterministic hashing fallback ----------------------------------------

/** FNV-1a 32-bit — small, fast, dependency-free, good enough for bucketing. */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((t) => t.length > 1);
}

export class HashEmbeddingProvider implements EmbeddingProvider {
  readonly id = "hash:fnv1a-bow";
  readonly dimensions = EMBEDDING_DIMENSIONS;

  // Documents and queries share the same lexical space, so the interface's
  // inputType arg is simply not declared here (fewer params is assignable).
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.embedOne(t));
  }

  private embedOne(text: string): number[] {
    const vec = new Array<number>(this.dimensions).fill(0);
    const counts = new Map<string, number>();
    for (const tok of tokenize(text)) {
      counts.set(tok, (counts.get(tok) ?? 0) + 1);
    }
    for (const [tok, tf] of counts) {
      const bucket = fnv1a(tok) % this.dimensions;
      // Sign hashing reduces collision bias; log-damped term frequency.
      const sign = fnv1a(`s:${tok}`) % 2 === 0 ? 1 : -1;
      vec[bucket] += sign * (1 + Math.log(tf));
    }
    return normalize(vec);
  }
}

/** L2-normalize so cosine distance == 1 - dot product. Zero vectors stay zero. */
export function normalize(vec: number[]): number[] {
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}

/**
 * Pick the embedding provider: Voyage when VOYAGE_API_KEY is configured,
 * otherwise the deterministic hashing fallback. Returns the provider plus a
 * `live` flag and a human note so callers/UX can say which is in use.
 */
export function getEmbeddingProvider(): {
  provider: EmbeddingProvider;
  live: boolean;
  note: string;
} {
  const apiKey = process.env.VOYAGE_API_KEY?.trim();
  if (apiKey) {
    return {
      provider: new VoyageEmbeddingProvider({ apiKey }),
      live: true,
      note: "Voyage embeddings.",
    };
  }
  return {
    provider: new HashEmbeddingProvider(),
    live: false,
    note: "No VOYAGE_API_KEY set — using the deterministic hashing fallback (lexical, not semantic). Set VOYAGE_API_KEY for production-quality retrieval.",
  };
}
