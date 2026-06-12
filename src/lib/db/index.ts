/**
 * Tenant-scoped Postgres access layer.
 *
 * Tenant isolation is enforced in two layers (see db/README.md):
 *   1. Here, at the query layer: every tenant operation runs inside
 *      `withOrg(orgId, …)`, which opens a transaction and sets the
 *      `app.current_org_id` GUC for its lifetime.
 *   2. In the database: Row-Level Security policies keyed on that GUC are the
 *      backstop, so a missing `WHERE org_id = …` cannot leak across tenants.
 *
 * Cross-org bootstrap/admin work (onboarding lookups, ingestion writes that
 * span the tenant boundary) uses `withServiceRole(…)`, which sets
 * `app.bypass_rls = 'on'` instead. Use it deliberately and never from a path
 * that handles untrusted tenant input.
 *
 * The pool is created lazily so importing this module never requires a live
 * database (keeps `next build` and unit tests that don't touch the DB green).
 */
import { Pool, type PoolClient, type QueryResultRow } from "pg";

/** Dimensionality of stored embeddings — Voyage voyage-3.5 / voyage-3-large default. */
export const EMBEDDING_DIMENSIONS = 1024;

let pool: Pool | undefined;

/**
 * The shared connection pool. Connects as the ordinary application role via
 * DATABASE_URL — that role must NOT be a superuser or BYPASSRLS role, or the
 * RLS backstop is silently disabled.
 */
export function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        "DATABASE_URL is not set. Configure it in .env.local (see .env.example).",
      );
    }
    pool = new Pool({ connectionString });
  }
  return pool;
}

/** Close the pool (tests, scripts, graceful shutdown). */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

/**
 * Run `fn` inside a transaction scoped to a single org. Sets
 * `app.current_org_id` so RLS filters every statement to `orgId`. The setting
 * is transaction-local (`set_config(..., true)`), so it never leaks to other
 * pooled clients. Commits on success, rolls back on throw.
 */
export async function withOrg<T>(
  orgId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_org_id', $1, true)", [
      orgId,
    ]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Run `fn` inside a transaction that bypasses tenant RLS, for trusted
 * cross-org bootstrap/admin work only (e.g. "which orgs does this user belong
 * to?" during onboarding, or service-side ingestion). Never expose this to a
 * request path driven by tenant-supplied org ids.
 */
export async function withServiceRole<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.bypass_rls', 'on', true)");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Format a numeric vector as the pgvector text literal (`[0.1,0.2,…]`).
 * Bind the result as a normal parameter and cast in SQL: `$1::vector`.
 */
export function toVector(values: readonly number[]): string {
  if (values.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Expected ${EMBEDDING_DIMENSIONS}-dim embedding, got ${values.length}.`,
    );
  }
  return `[${values.join(",")}]`;
}

/** Convenience typed query against an explicit client (inside withOrg/withServiceRole). */
export function query<R extends QueryResultRow = QueryResultRow>(
  client: PoolClient,
  text: string,
  params?: unknown[],
) {
  return client.query<R>(text, params as never[]);
}

export type Role = "owner" | "admin" | "agent" | "viewer";
export type ConversationStatus = "open" | "pending" | "resolved" | "escalated";
export type DraftedAnswerStatus =
  | "suggested"
  | "approved"
  | "sent"
  | "escalated";
export type EscalationStatus = "open" | "acknowledged" | "resolved";
