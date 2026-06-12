/**
 * Schema smoke test (BAB-15 acceptance).
 *
 * Proves, against a real Postgres + pgvector:
 *   1. An org + a kb_chunk with an embedding can be inserted and queried back,
 *      scoped by org_id (cosine nearest-neighbour over pgvector).
 *   2. The full table set (knowledge_sources → documents → kb_chunks,
 *      conversations → messages → drafted_answers → escalations) accepts a row.
 *   3. Tenant isolation holds: an org cannot see another org's rows. This
 *      check is only meaningful when connected as an ordinary (non-superuser,
 *      non-BYPASSRLS) role; it is skipped with a warning otherwise, because
 *      privileged roles bypass RLS by design.
 *
 * Run after db:migrate. Usage: npm run db:smoke
 */
import {
  EMBEDDING_DIMENSIONS,
  closePool,
  toVector,
  withOrg,
  withServiceRole,
} from "../src/lib/db";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`Smoke assertion failed: ${msg}`);
}

/** A deterministic unit-ish embedding; values vary by seed so vectors differ. */
function makeEmbedding(seed: number): number[] {
  return Array.from(
    { length: EMBEDDING_DIMENSIONS },
    (_, i) => ((i + seed) % 7) / 10,
  );
}

async function main(): Promise<void> {
  const slugA = "smoke-org-a";
  const slugB = "smoke-org-b";

  // Clean any leftovers from a previous run (cross-org → service role).
  await withServiceRole(async (c) => {
    await c.query("DELETE FROM orgs WHERE slug = ANY($1)", [[slugA, slugB]]);
  });

  // Detect whether the current role is governed by RLS at all.
  const { rows: privRows } = await withServiceRole((c) =>
    c.query<{ privileged: boolean }>(
      "SELECT (rolsuper OR rolbypassrls) AS privileged FROM pg_roles WHERE rolname = current_user",
    ),
  );
  const privileged = privRows[0]?.privileged ?? true;

  // Create two tenants (cross-org bootstrap → service role).
  const { orgA, orgB } = await withServiceRole(async (c) => {
    const a = await c.query<{ id: string }>(
      "INSERT INTO orgs (name, slug) VALUES ($1, $2) RETURNING id",
      ["Smoke Org A", slugA],
    );
    const b = await c.query<{ id: string }>(
      "INSERT INTO orgs (name, slug) VALUES ($1, $2) RETURNING id",
      ["Smoke Org B", slugB],
    );
    return { orgA: a.rows[0].id, orgB: b.rows[0].id };
  });
  console.log(`✓ created orgs A=${orgA} B=${orgB}`);

  // --- Acceptance core: insert org + kb_chunk with embedding, query it back ---
  const queryVec = toVector(makeEmbedding(0));
  const chunkId = await withOrg(orgA, async (c) => {
    const src = await c.query<{ id: string }>(
      `INSERT INTO knowledge_sources (org_id, type, name)
       VALUES ($1, 'manual', 'Smoke source') RETURNING id`,
      [orgA],
    );
    const doc = await c.query<{ id: string }>(
      `INSERT INTO documents (org_id, knowledge_source_id, title, content)
       VALUES ($1, $2, 'Smoke doc', 'hello world') RETURNING id`,
      [orgA, src.rows[0].id],
    );
    const chunk = await c.query<{ id: string }>(
      `INSERT INTO kb_chunks (org_id, document_id, chunk_index, content, token_count, embedding)
       VALUES ($1, $2, 0, 'hello world', 2, $3::vector) RETURNING id`,
      [orgA, doc.rows[0].id, queryVec],
    );
    return chunk.rows[0].id;
  });
  console.log(
    `✓ inserted kb_chunk ${chunkId} with a ${EMBEDDING_DIMENSIONS}-dim embedding`,
  );

  // Vector retrieval, scoped to org A.
  const retrieved = await withOrg(orgA, async (c) => {
    const r = await c.query<{ id: string; org_id: string; distance: number }>(
      `SELECT id, org_id, embedding <=> $1::vector AS distance
       FROM kb_chunks
       ORDER BY embedding <=> $1::vector
       LIMIT 1`,
      [queryVec],
    );
    return r.rows[0];
  });
  assert(retrieved, "expected to retrieve a chunk for org A");
  assert(retrieved.id === chunkId, "retrieved the chunk we inserted");
  assert(retrieved.org_id === orgA, "retrieved chunk is scoped to org A");
  console.log(
    `✓ cosine query returned the chunk (distance=${retrieved.distance})`,
  );

  // --- Exercise the rest of the schema under org A ---
  await withOrg(orgA, async (c) => {
    const conv = await c.query<{ id: string }>(
      `INSERT INTO conversations (org_id, channel, subject)
       VALUES ($1, 'widget', 'How do I reset my password?') RETURNING id`,
      [orgA],
    );
    const msg = await c.query<{ id: string }>(
      `INSERT INTO messages (org_id, conversation_id, role, body)
       VALUES ($1, $2, 'customer', 'How do I reset my password?') RETURNING id`,
      [orgA, conv.rows[0].id],
    );
    const draft = await c.query<{ id: string }>(
      `INSERT INTO drafted_answers
         (org_id, conversation_id, question_message_id, body, citations, confidence, status, model)
       VALUES ($1, $2, $3, 'Open Settings → Security → Reset password.',
               $4::jsonb, 0.91, 'suggested', 'claude-opus-4-8')
       RETURNING id`,
      [
        orgA,
        conv.rows[0].id,
        msg.rows[0].id,
        JSON.stringify([
          { chunk_id: chunkId, quote: "hello world", score: 0.91 },
        ]),
      ],
    );
    await c.query(
      `INSERT INTO escalations (org_id, conversation_id, drafted_answer_id, reason, status)
       VALUES ($1, $2, $3, 'low confidence', 'open')`,
      [orgA, conv.rows[0].id, draft.rows[0].id],
    );
  });
  console.log(
    "✓ inserted conversation → message → drafted_answer → escalation",
  );

  // --- Tenant isolation: org B must not see org A's chunk ---
  const visibleToB = await withOrg(orgB, async (c) => {
    const r = await c.query<{ count: string }>(
      "SELECT count(*) FROM kb_chunks",
    );
    return Number(r.rows[0].count);
  });
  if (privileged) {
    console.log(
      `⚠ RLS isolation check SKIPPED — current role bypasses RLS (superuser/BYPASSRLS). ` +
        `org B saw ${visibleToB} chunk(s). Run as an ordinary role (CI does) to enforce this.`,
    );
  } else {
    assert(
      visibleToB === 0,
      `tenant isolation breach: org B can see ${visibleToB} of org A's chunks`,
    );
    console.log(
      "✓ tenant isolation enforced by RLS — org B sees 0 of org A's chunks",
    );
  }

  // Cleanup.
  await withServiceRole(async (c) => {
    await c.query("DELETE FROM orgs WHERE slug = ANY($1)", [[slugA, slugB]]);
  });
  console.log("✓ cleaned up");
  console.log("\nSMOKE OK");
}

main()
  .then(() => closePool())
  .catch(async (err) => {
    console.error("\nSMOKE FAILED\n", err);
    await closePool();
    process.exit(1);
  });
