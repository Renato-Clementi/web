# Database — multi-tenant schema (support deflection)

Relational + vector schema for the AI support-deflection MVP (Direction C, see
[BAB-3 plan §13](/BAB/issues/BAB-3#document-plan)). One managed Postgres holds
both relational data and embeddings via the `pgvector` extension — no separate
vector store to operate.

## Layout & conventions

```
db/
  migrations/NNNN_name.sql   ordered, applied once each, tracked in schema_migrations
  migrate.ts                 the runner (npm run db:migrate)
  smoke.ts                   acceptance smoke test (npm run db:smoke)
src/lib/db/index.ts          tenant-scoped query layer used by the app
```

- **Migrations** are plain SQL files, applied in filename order, each recorded
  in a `schema_migrations` table. The runner wraps every file in one
  transaction with its bookkeeping row, so a migration applies fully or not at
  all. Add the next change as `0002_*.sql`; never edit an applied migration.
- **UUID** primary keys (`gen_random_uuid()`, built into Postgres ≥ 13).
- **timestamptz** `created_at` / `updated_at`; `updated_at` maintained by the
  `set_updated_at()` trigger.
- **Enum-like** columns are `text` + `CHECK` (cheap to evolve vs. `ALTER TYPE`).

## Running

```bash
# any managed Postgres with the pgvector extension available (Neon / Supabase /
# self-hosted), or a local container:
docker run -d --name baboo-pg -e POSTGRES_PASSWORD=postgres \
  -p 5432:5432 pgvector/pgvector:pg16

export DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres
npm run db:migrate
npm run db:smoke
```

CI (`.github/workflows/ci.yml`, `db` job) runs both on every push/PR against
`pgvector/pgvector:pg16`, applying migrations as the owner and running the smoke
test as a non-privileged `app_user` so the RLS isolation assertion is real.

## Tenant isolation (the one-way-door decision)

Every tenant-owned row carries `org_id`. Isolation is enforced in **two layers**:

1. **Query layer** — all tenant work runs inside `withOrg(orgId, client => …)`
   (`src/lib/db/index.ts`), which opens a transaction and sets the
   `app.current_org_id` GUC for its lifetime.
2. **Row-Level Security** — every tenant table has RLS `ENABLE`d + `FORCE`d with
   a policy keyed on that GUC:

   ```sql
   org_id = current_setting('app.current_org_id', true)::uuid
     OR current_setting('app.bypass_rls', true) = 'on'
   ```

   `current_setting(..., true)` returns `NULL` when unset, so with no context
   and no bypass **no rows are visible** — isolation fails closed. A forgotten
   `WHERE org_id = …` cannot leak across tenants.

   ⚠️ The application **must connect as an ordinary role**. Superusers and
   `BYPASSRLS` roles ignore RLS even under `FORCE`. On Neon use a regular role;
   on Supabase the `anon`/`authenticated` roles are already non-superuser.

3. **Same-org foreign keys** — cross-table links use composite
   `(org_id, parent_id) → parent(org_id, id)` FKs, so a child can never
   reference a parent in another org even at the database level.

### Cross-org / bootstrap work

Some operations legitimately span the tenant boundary before an org context
exists — onboarding ("which orgs does this user belong to?"), service-side
ingestion. Those use `withServiceRole(client => …)`, which sets
`app.bypass_rls = 'on'`. **Never** drive it from a request path that takes a
tenant-supplied `org_id`. The auth/role model is finalized in
[BAB-16](/BAB/issues/BAB-16).

## Embeddings & index plan

- `kb_chunks.embedding` is `vector(1024)` — the default dimensionality of
  Voyage `voyage-3.5` / `voyage-3-large` (the planned embedding model,
  [BAB-3 §13](/BAB/issues/BAB-3#document-plan)). If a different model/dimension
  is chosen in ingestion ([BAB-17](/BAB/issues/BAB-17)), change the column and
  index in a new migration.
- Index: **HNSW** with `vector_cosine_ops` (`kb_chunks_embedding_hnsw`). HNSW
  gives high recall and fast queries and builds incrementally on insert — a good
  default for a growing, write-as-you-ingest knowledge base. Query with the
  cosine-distance operator `<=>`. Embeddings are expected to be normalized.
  Alternative: `ivfflat` (smaller, faster to build, needs a populated table and
  a tuned `lists` value) — switch in a later migration if index size matters.

## Tables

| Table               | Purpose                                                          | Tenant key |
| ------------------- | ---------------------------------------------------------------- | ---------- |
| `orgs`              | Tenant root.                                                     | `id`       |
| `users`             | **Global** identity (one person, may join many orgs).            | —          |
| `memberships`       | User ↔ org membership + `role` (owner/admin/agent/viewer).       | `org_id`   |
| `knowledge_sources` | A configured origin of knowledge (help center, upload, import…). | `org_id`   |
| `documents`         | A unit of source content within a source.                        | `org_id`   |
| `kb_chunks`         | Embedded, retrievable slices of a document (`embedding`).        | `org_id`   |
| `conversations`     | An inbound support thread (widget/api/email).                    | `org_id`   |
| `messages`          | Turns within a conversation (customer/assistant/agent/system).   | `org_id`   |
| `drafted_answers`   | AI draft: `body`, `citations[]`, `confidence`, `status`.         | `org_id`   |
| `escalations`       | Hand-off of a conversation to a human.                           | `org_id`   |

`users` is intentionally global (not `org_id`-scoped): identity is shared across
tenants, and tenancy lives in `memberships`. Access to `users` is mediated by
the app via membership; it is the one table without an RLS org policy.

`drafted_answers.citations` is a JSON array of
`{ chunk_id, document_id, quote, score }`. `drafted_answers.status` is one of
`suggested | approved | sent | escalated`.

**Out of scope here** (separate tasks): ingestion logic
([BAB-17](/BAB/issues/BAB-17)), auth flows ([BAB-16](/BAB/issues/BAB-16)), UI.
