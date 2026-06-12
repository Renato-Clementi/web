# Knowledge ingestion pipeline (BAB-17)

Ingest an org's help-center docs and past resolved tickets → parse → chunk →
embed → store in `documents` + `kb_chunks` (the multi-tenant schema from
[BAB-15](../db/../../db/README.md)). Retrieval over the embedded chunks is the
seam the answer engine ([BAB-18]) builds on.

```
parse → chunk → embed → store (documents + kb_chunks)        retrieve
 │        │       │        │                                    │
parse.ts chunk.ts embed.ts ingest.ts                         retrieve.ts
html.ts                     ↑ tracked by ingestion_jobs
csv.ts / tickets.ts (tickets CSV → RawDocument[])
```

## Modules

| File          | Responsibility                                                             |
| ------------- | -------------------------------------------------------------------------- |
| `parse.ts`    | Raw input → clean plain text + title + content hash. HTML/markdown/text.   |
| `html.ts`     | Dependency-free HTML → text (drop script/style, block tags → newlines).    |
| `csv.ts`      | Minimal RFC-4180 CSV parser (quotes, embedded commas/newlines).            |
| `tickets.ts`  | Tickets CSV → `RawDocument[]` (auto-detected columns; resolved-only).      |
| `chunk.ts`    | Paragraph/sentence-aware overlapping windows (~512 tok, 64 overlap).       |
| `embed.ts`    | `EmbeddingProvider`: Voyage (real) or deterministic hashing (fallback).    |
| `ingest.ts`   | The pipeline + async job runner; updates `ingestion_jobs`.                 |
| `retrieve.ts` | Cosine NN search over `kb_chunks` → chunks with source refs for citations. |
| `types.ts`    | Shared types.                                                              |

## Embeddings

`getEmbeddingProvider()` picks the provider, mirroring the repo's live/demo
pattern (`src/lib/leads/source.ts`):

- **`VOYAGE_API_KEY` set** → Voyage `voyage-3` (1024-dim, matches
  `kb_chunks.vector(1024)`). Override the model with `VOYAGE_MODEL`.
- **unset** → a deterministic, dependency-free feature-hashing bag-of-words
  embedding. It is **lexical, not semantic**, but chunks that share words land
  near a query that shares them — so the whole pipeline (and CI) runs with no
  secret, and production gets Voyage quality by just setting the key.

Both emit L2-normalized vectors, so cosine distance (the `kb_chunks` HNSW index)
behaves identically. The **same** provider must embed both documents and
queries — always go through `getEmbeddingProvider()`.

## Async job model

`enqueueIngestion()` creates an `ingestion_jobs` row, returns its id, and
processes in the background (fire-and-forget). `ingest()` runs it awaited (CLI /
tests). For v0 the runner is in-process; on serverless a request may freeze
after responding, so production should move the runner behind a durable queue
(Inngest / cron+queue, [BAB-3] §5). The job table and runner signature stay the
same across that swap.

Idempotency: a document is keyed by `(knowledge_source_id, content_hash)`, so
re-ingesting identical content skips re-embedding.

## HTTP API (interim auth)

Real session auth + org scoping land in [BAB-16]. Until then these routes are
**off** unless `INGEST_INTERNAL_KEY` is set, and require a matching
`x-internal-key` header (`orgId` comes from the trusted caller — do not expose
publicly before BAB-16):

- `POST /api/kb/ingest` → `202 { jobId, knowledgeSourceId }`. Body: `orgId`,
  `kind` (`"docs"|"tickets"`), `source` (`{type,name,config?}`), plus either
  `documents[]` or `ticketsCsv` (and optional `columnMapping`, `chunkOptions`).
- `GET /api/kb/jobs/{jobId}?orgId=...` → the job row (status + progress).

## Verify (acceptance)

`db/kb-smoke.ts` proves the acceptance criteria against a live Postgres +
pgvector: ingest the sample doc set (`db/fixtures/kb/`) + tickets CSV → embedded
org-scoped chunks → relevant retrieval with source refs → tenant isolation.

```bash
export DATABASE_URL=postgres://user:pw@host:5432/db   # pgvector-enabled
npm run db:migrate
npx tsx db/kb-smoke.ts
```

CI runs it on every push/PR (`.github/workflows/ci.yml`, `db` job) as the
non-privileged `app_user`, so the tenant-isolation assertion is enforced.

Unit tests for the pure modules (parse/chunk/csv/tickets/embed, incl. the
lexical-ranking property) live in `kb.test.ts` and run with `npm test`.

[BAB-3]: /BAB/issues/BAB-3#document-plan
[BAB-16]: /BAB/issues/BAB-16
[BAB-18]: /BAB/issues/BAB-18
