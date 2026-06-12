-- 0001_initial_schema.sql
-- Baboo support-deflection MVP (Direction C) — multi-tenant relational + vector schema.
--
-- One-way-door design goals (see db/README.md for the full rationale):
--   1. Every tenant-owned row carries org_id and is isolated by it.
--   2. Tenant isolation is enforced in TWO layers:
--        a. The query layer (src/lib/db) opens every tenant transaction inside
--           withOrg(orgId), which sets the `app.current_org_id` GUC.
--        b. Row-Level Security policies on that GUC are the database-level
--           backstop, so a forgotten WHERE clause cannot leak across tenants.
--   3. Cross-table links are constrained to the SAME org via composite
--      (org_id, id) foreign keys — a child can never point at a parent in
--      another tenant, even by bug or malice.
--
-- Conventions established here (first migration in the repo — see db/README.md):
--   * Plain, ordered SQL files in db/migrations/NNNN_name.sql, applied once each
--     and tracked in schema_migrations by the db/migrate.ts runner.
--   * UUID primary keys via gen_random_uuid() (built in since Postgres 13).
--   * timestamptz created_at/updated_at; updated_at maintained by a trigger.
--   * Status/enum-like columns are text + CHECK (cheap to evolve vs. ALTER TYPE).
--
-- The runner (db/migrate.ts) wraps each migration file in a single
-- transaction, so this file intentionally contains no BEGIN/COMMIT.

-- pgvector: relational data and embeddings live in one managed Postgres.
CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------

-- Auto-maintain updated_at on UPDATE.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- orgs — the tenant root
-- ---------------------------------------------------------------------------
CREATE TABLE orgs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  slug        text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER orgs_set_updated_at BEFORE UPDATE ON orgs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- users — GLOBAL identity (intentionally NOT org-scoped).
-- A person is one identity that may belong to several orgs; tenancy lives in
-- memberships. The concrete auth provider (Supabase vs Clerk) is decided in
-- BAB-16; auth_provider/auth_subject hold the external identity when it lands.
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text NOT NULL,
  full_name      text,
  auth_provider  text,
  auth_subject   text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
-- Case-insensitive unique email; unique external identity when present.
CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));
CREATE UNIQUE INDEX users_auth_identity_key ON users (auth_provider, auth_subject)
  WHERE auth_provider IS NOT NULL AND auth_subject IS NOT NULL;
CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- memberships — which user belongs to which org, and with what role.
-- ---------------------------------------------------------------------------
CREATE TABLE memberships (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role        text NOT NULL DEFAULT 'agent'
                CHECK (role IN ('owner', 'admin', 'agent', 'viewer')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id)
);
CREATE INDEX memberships_user_idx ON memberships (user_id);
CREATE TRIGGER memberships_set_updated_at BEFORE UPDATE ON memberships
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- knowledge_sources — a configured origin of knowledge for an org.
-- ---------------------------------------------------------------------------
CREATE TABLE knowledge_sources (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  type            text NOT NULL
                    CHECK (type IN ('help_center', 'website', 'file_upload',
                                    'ticket_import', 'manual')),
  name            text NOT NULL,
  config          jsonb NOT NULL DEFAULT '{}'::jsonb,
  status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'paused', 'error')),
  last_synced_at  timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- Target for composite, same-org foreign keys from children.
  UNIQUE (org_id, id)
);
CREATE INDEX knowledge_sources_org_idx ON knowledge_sources (org_id);
CREATE TRIGGER knowledge_sources_set_updated_at BEFORE UPDATE ON knowledge_sources
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- documents — a unit of source content (a help article, an imported ticket…).
-- ---------------------------------------------------------------------------
CREATE TABLE documents (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  knowledge_source_id  uuid NOT NULL,
  title                text,
  uri                  text,
  mime_type            text,
  content_hash         text,
  content              text,
  metadata             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  -- Same-org link: a document's source must belong to the same tenant.
  FOREIGN KEY (org_id, knowledge_source_id)
    REFERENCES knowledge_sources (org_id, id) ON DELETE CASCADE
);
CREATE INDEX documents_source_idx ON documents (org_id, knowledge_source_id);
CREATE TRIGGER documents_set_updated_at BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- kb_chunks — embedded, retrievable slices of a document.
-- embedding is vector(1024): Voyage voyage-3.5 / voyage-3-large default dim
-- (see db/README.md "Embeddings & index plan"). Nullable so chunks can be
-- staged before the embedding job (BAB-17) fills them in.
-- ---------------------------------------------------------------------------
CREATE TABLE kb_chunks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  document_id  uuid NOT NULL,
  chunk_index  integer NOT NULL,
  content      text NOT NULL,
  token_count  integer,
  embedding    vector(1024),
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, document_id, chunk_index),
  FOREIGN KEY (org_id, document_id)
    REFERENCES documents (org_id, id) ON DELETE CASCADE
);
CREATE INDEX kb_chunks_org_idx ON kb_chunks (org_id);
-- Approximate-nearest-neighbour index for cosine similarity over normalized
-- embeddings. HNSW: high recall + fast queries, built incrementally on insert.
CREATE INDEX kb_chunks_embedding_hnsw
  ON kb_chunks USING hnsw (embedding vector_cosine_ops);
CREATE TRIGGER kb_chunks_set_updated_at BEFORE UPDATE ON kb_chunks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- conversations — an inbound support thread.
-- ---------------------------------------------------------------------------
CREATE TABLE conversations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  channel      text NOT NULL DEFAULT 'widget'
                 CHECK (channel IN ('widget', 'api', 'email')),
  external_id  text,
  subject      text,
  status       text NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open', 'pending', 'resolved', 'escalated')),
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);
CREATE INDEX conversations_org_status_idx ON conversations (org_id, status);
CREATE TRIGGER conversations_set_updated_at BEFORE UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- messages — turns within a conversation.
-- ---------------------------------------------------------------------------
CREATE TABLE messages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  conversation_id  uuid NOT NULL,
  role             text NOT NULL
                     CHECK (role IN ('customer', 'assistant', 'agent', 'system')),
  body             text NOT NULL,
  metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, conversation_id)
    REFERENCES conversations (org_id, id) ON DELETE CASCADE
);
CREATE INDEX messages_conversation_idx
  ON messages (org_id, conversation_id, created_at);

-- ---------------------------------------------------------------------------
-- drafted_answers — an AI-drafted reply with citations, confidence, status.
-- ---------------------------------------------------------------------------
CREATE TABLE drafted_answers (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  conversation_id      uuid NOT NULL,
  question_message_id  uuid,
  body                 text NOT NULL,
  -- citations[]: JSON array of { chunk_id, document_id, quote, score }.
  citations            jsonb NOT NULL DEFAULT '[]'::jsonb,
  confidence           numeric(5, 4) CHECK (confidence >= 0 AND confidence <= 1),
  status               text NOT NULL DEFAULT 'suggested'
                         CHECK (status IN ('suggested', 'approved', 'sent', 'escalated')),
  model                text,
  created_by_user_id   uuid REFERENCES users (id) ON DELETE SET NULL,
  approved_by_user_id  uuid REFERENCES users (id) ON DELETE SET NULL,
  approved_at          timestamptz,
  sent_at              timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, conversation_id)
    REFERENCES conversations (org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, question_message_id)
    REFERENCES messages (org_id, id) ON DELETE SET NULL
);
CREATE INDEX drafted_answers_conversation_idx
  ON drafted_answers (org_id, conversation_id);
CREATE INDEX drafted_answers_status_idx ON drafted_answers (org_id, status);
CREATE TRIGGER drafted_answers_set_updated_at BEFORE UPDATE ON drafted_answers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- escalations — when the AI defers a conversation to a human.
-- ---------------------------------------------------------------------------
CREATE TABLE escalations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  conversation_id     uuid NOT NULL,
  drafted_answer_id   uuid,
  reason              text,
  status              text NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open', 'acknowledged', 'resolved')),
  assigned_to_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  resolved_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, conversation_id)
    REFERENCES conversations (org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, drafted_answer_id)
    REFERENCES drafted_answers (org_id, id) ON DELETE SET NULL
);
CREATE INDEX escalations_status_idx ON escalations (org_id, status);
CREATE TRIGGER escalations_set_updated_at BEFORE UPDATE ON escalations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Row-Level Security — the database-level tenant-isolation backstop.
--
-- Policy: a row is visible/writable when its org_id matches the
-- `app.current_org_id` GUC set by withOrg(orgId), OR when an explicit
-- service context (`app.bypass_rls = 'on'`, set by withServiceRole) is active
-- for cross-org bootstrap/admin work (onboarding lookups, ingestion).
--
-- current_setting(..., true) returns NULL when unset, so with no context and
-- no bypass NO rows are visible — isolation fails closed.
--
-- FORCE ROW LEVEL SECURITY makes the policy apply even to the table owner.
-- (Superusers / BYPASSRLS roles still bypass — the app must connect as an
-- ordinary role; see db/README.md.)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'orgs', 'memberships', 'knowledge_sources', 'documents', 'kb_chunks',
    'conversations', 'messages', 'drafted_answers', 'escalations'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
    IF t = 'orgs' THEN
      -- orgs keys on id (it has no org_id column).
      EXECUTE format($f$
        CREATE POLICY tenant_isolation ON %I
          USING (id = current_setting('app.current_org_id', true)::uuid
                 OR current_setting('app.bypass_rls', true) = 'on')
          WITH CHECK (id = current_setting('app.current_org_id', true)::uuid
                 OR current_setting('app.bypass_rls', true) = 'on');
      $f$, t);
    ELSE
      EXECUTE format($f$
        CREATE POLICY tenant_isolation ON %I
          USING (org_id = current_setting('app.current_org_id', true)::uuid
                 OR current_setting('app.bypass_rls', true) = 'on')
          WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid
                 OR current_setting('app.bypass_rls', true) = 'on');
      $f$, t);
    END IF;
  END LOOP;
END;
$$;
