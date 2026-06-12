-- 0002_ingestion_jobs.sql
-- Knowledge ingestion pipeline (BAB-17): track async ingestion runs.
--
-- An ingestion job parses → chunks → embeds a batch of source content
-- (help-center docs and/or a past-tickets CSV) into kb_chunks. The work runs
-- out of band (fire-and-forget from the API route, or awaited from the CLI),
-- so we persist a row to report progress and surface failures. Production can
-- later swap the in-process runner for a durable queue (Inngest / cron+queue,
-- BAB-3 plan §5) without changing this table.
--
-- Follows the conventions set in 0001: org-scoped, RLS-isolated, composite
-- same-org FK to its knowledge_source, text+CHECK status, updated_at trigger.

CREATE TABLE ingestion_jobs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  knowledge_source_id  uuid NOT NULL,
  kind                 text NOT NULL
                         CHECK (kind IN ('docs', 'tickets')),
  status               text NOT NULL DEFAULT 'queued'
                         CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  total_documents      integer NOT NULL DEFAULT 0,
  processed_documents  integer NOT NULL DEFAULT 0,
  total_chunks         integer NOT NULL DEFAULT 0,
  embedded_chunks      integer NOT NULL DEFAULT 0,
  embedding_provider   text,
  error                text,
  metadata             jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at           timestamptz,
  finished_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  -- Same-org link: a job's source must belong to the same tenant.
  FOREIGN KEY (org_id, knowledge_source_id)
    REFERENCES knowledge_sources (org_id, id) ON DELETE CASCADE
);
CREATE INDEX ingestion_jobs_source_idx
  ON ingestion_jobs (org_id, knowledge_source_id);
CREATE INDEX ingestion_jobs_status_idx ON ingestion_jobs (org_id, status);
CREATE TRIGGER ingestion_jobs_set_updated_at BEFORE UPDATE ON ingestion_jobs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- RLS: same tenant-isolation backstop as every other org-scoped table (0001).
ALTER TABLE ingestion_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingestion_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ingestion_jobs
  USING (org_id = current_setting('app.current_org_id', true)::uuid
         OR current_setting('app.bypass_rls', true) = 'on')
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid
         OR current_setting('app.bypass_rls', true) = 'on');
