-- 0003_rls_guc_nullif.sql
-- Fix a latent RLS bug from 0001/0002 (found via BAB-17 CI smoke).
--
-- The tenant-isolation policies cast the org GUC directly:
--     current_setting('app.current_org_id', true)::uuid
-- `current_setting(..., true)` returns NULL only when the GUC was NEVER set in
-- the session. But `app.current_org_id` is a placeholder GUC, and once any
-- statement in the session has set it (e.g. a prior withOrg() on a pooled
-- connection, reset on COMMIT because we use set_config(..., is_local=true)),
-- it reverts to the placeholder default — the EMPTY STRING, not NULL. The cast
-- ''::uuid then raises `invalid input syntax for type uuid: ""` (SQLSTATE
-- 22P02).
--
-- This bites any path that relies on bypass without also setting
-- app.current_org_id — i.e. withServiceRole() reusing a pooled connection that
-- earlier served withOrg(). In CI it surfaced at the smoke cleanup DELETE; in
-- production it would hit cross-org bootstrap/admin work (onboarding lookups,
-- service-side ingestion) on a recycled connection.
--
-- Fix: guard every cast with NULLIF(..., '') so an empty GUC collapses to NULL
-- (then `id = NULL` is NULL, harmless) instead of erroring. Same two-layer
-- model and policy semantics as 0001 — only the empty-string edge is repaired.
--
-- Recreates the `tenant_isolation` policy on every RLS table (the nine from
-- 0001 plus ingestion_jobs from 0002). RLS stays ENABLED + FORCED; we only
-- replace the policy body.

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'orgs', 'memberships', 'knowledge_sources', 'documents', 'kb_chunks',
    'conversations', 'messages', 'drafted_answers', 'escalations',
    'ingestion_jobs'
  ]
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I;', t);
    IF t = 'orgs' THEN
      -- orgs keys on id (it has no org_id column).
      EXECUTE format($f$
        CREATE POLICY tenant_isolation ON %I
          USING (id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
                 OR current_setting('app.bypass_rls', true) = 'on')
          WITH CHECK (id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
                 OR current_setting('app.bypass_rls', true) = 'on');
      $f$, t);
    ELSE
      EXECUTE format($f$
        CREATE POLICY tenant_isolation ON %I
          USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
                 OR current_setting('app.bypass_rls', true) = 'on')
          WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
                 OR current_setting('app.bypass_rls', true) = 'on');
      $f$, t);
    END IF;
  END LOOP;
END;
$$;
