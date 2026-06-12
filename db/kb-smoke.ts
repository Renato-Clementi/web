/**
 * Knowledge ingestion acceptance smoke test (BAB-17).
 *
 * Proves the issue's acceptance criteria against a real Postgres + pgvector:
 *   1. Ingesting a sample doc set (markdown + HTML + plain text) produces
 *      org-scoped embedded kb_chunks via an ingestion_jobs run.
 *   2. Importing a past-tickets CSV ingests only the RESOLVED tickets.
 *   3. A retrieval query returns relevant chunks WITH source references.
 *   4. Retrieval is tenant-scoped: another org sees none of these chunks.
 *
 * Embeddings use whatever getEmbeddingProvider() selects: Voyage when
 * VOYAGE_API_KEY is set, otherwise the deterministic hashing fallback — so this
 * runs in CI with no secret. Run after db:migrate. Usage: npm run kb:smoke
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { closePool, withServiceRole, withOrg } from "../src/lib/db";
import { getEmbeddingProvider } from "../src/lib/kb/embed";
import { ticketsCsvToDocuments } from "../src/lib/kb/tickets";
import { ingest } from "../src/lib/kb/ingest";
import { retrieveChunks } from "../src/lib/kb/retrieve";
import type { RawDocument } from "../src/lib/kb/types";

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "kb",
);

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`Smoke assertion failed: ${msg}`);
}

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}

async function main(): Promise<void> {
  const slug = "kb-smoke-org";
  const slugB = "kb-smoke-org-b";
  const { note } = getEmbeddingProvider();
  console.log(`• embedding provider: ${note}`);

  // Clean leftovers + create two tenants (cross-org → service role).
  const { orgId, orgB } = await withServiceRole(async (c) => {
    await c.query("DELETE FROM orgs WHERE slug = ANY($1)", [[slug, slugB]]);
    const a = await c.query<{ id: string }>(
      "INSERT INTO orgs (name, slug) VALUES ($1, $2) RETURNING id",
      ["KB Smoke Org", slug],
    );
    const b = await c.query<{ id: string }>(
      "INSERT INTO orgs (name, slug) VALUES ($1, $2) RETURNING id",
      ["KB Smoke Org B", slugB],
    );
    return { orgId: a.rows[0].id, orgB: b.rows[0].id };
  });
  console.log(`✓ created org ${orgId}`);

  // --- 1. Ingest the help-center doc set ------------------------------------
  const docs: RawDocument[] = [
    {
      uri: "help/password-reset.md",
      mimeType: "text/markdown",
      content: fixture("password-reset.md"),
    },
    {
      uri: "help/billing.html",
      mimeType: "text/html",
      content: fixture("billing.html"),
    },
    {
      uri: "help/shipping.txt",
      mimeType: "text/plain",
      content: fixture("shipping.txt"),
    },
  ];
  const docResult = await ingest(orgId, {
    kind: "docs",
    source: { type: "help_center", name: "Help center (smoke)" },
    documents: docs,
  });
  assert(
    docResult.status === "succeeded",
    `docs job failed: ${docResult.error}`,
  );
  assert(docResult.processedDocuments === 3, "all 3 docs processed");
  assert(docResult.totalChunks >= 3, "docs produced chunks");
  console.log(
    `✓ docs job ${docResult.jobId.slice(0, 8)} → ${docResult.totalChunks} chunks from ${docResult.processedDocuments} docs`,
  );

  // --- 2. Import the past-tickets CSV (resolved only) -----------------------
  const { documents: ticketDocs, skippedUnresolved } = ticketsCsvToDocuments(
    fixture("tickets.csv"),
  );
  assert(skippedUnresolved === 1, "the one open ticket is skipped");
  assert(ticketDocs.length === 4, "4 resolved tickets become documents");
  const ticketResult = await ingest(orgId, {
    kind: "tickets",
    source: { type: "ticket_import", name: "Past tickets (smoke)" },
    documents: ticketDocs,
  });
  assert(
    ticketResult.status === "succeeded",
    `tickets job failed: ${ticketResult.error}`,
  );
  assert(ticketResult.totalChunks >= 4, "tickets produced chunks");
  console.log(
    `✓ tickets job ${ticketResult.jobId.slice(0, 8)} → ${ticketResult.totalChunks} chunks from ${ticketResult.processedDocuments} resolved tickets`,
  );

  // --- 3. Retrieval returns relevant chunks WITH source refs ----------------
  const hits = await retrieveChunks(orgId, "how do I reset my password?", {
    limit: 3,
  });
  assert(hits.length > 0, "retrieval returned chunks");
  const top = hits[0];
  assert(
    /password/i.test(top.content),
    `top hit should be about passwords, got: ${top.content.slice(0, 80)}`,
  );
  assert(top.source.knowledgeSourceName != null, "hit carries a source name");
  assert(top.source.documentUri != null, "hit carries a document uri");
  assert(top.score > 0, "hit has a positive similarity score");
  console.log(
    `✓ query "reset password" → "${top.source.documentTitle}" ` +
      `[${top.source.knowledgeSourceType}] score=${top.score.toFixed(3)}`,
  );

  const refundHits = await retrieveChunks(orgId, "where is my refund money?", {
    limit: 3,
  });
  assert(refundHits.length > 0, "refund query returned chunks");
  assert(
    /refund/i.test(refundHits[0].content),
    "refund query surfaces refund content",
  );
  console.log(
    `✓ query "refund" → "${refundHits[0].source.documentTitle}" score=${refundHits[0].score.toFixed(3)}`,
  );

  // --- 4. Tenant isolation: org B sees none of org A's chunks ---------------
  const chunkCountB = await withOrg(orgB, async (c) => {
    const r = await c.query<{ count: string }>(
      "SELECT count(*) FROM kb_chunks",
    );
    return Number(r.rows[0].count);
  });
  const hitsB = await retrieveChunks(orgB, "how do I reset my password?", {
    limit: 3,
  });

  // privileged roles (superuser/BYPASSRLS) bypass RLS — only assert under an
  // ordinary role, matching db/smoke.ts.
  const { rows: privRows } = await withServiceRole((c) =>
    c.query<{ privileged: boolean }>(
      "SELECT (rolsuper OR rolbypassrls) AS privileged FROM pg_roles WHERE rolname = current_user",
    ),
  );
  if (privRows[0]?.privileged ?? true) {
    console.log(
      `⚠ tenant-isolation check SKIPPED — current role bypasses RLS. ` +
        `org B saw ${chunkCountB} chunk(s). Run as an ordinary role (CI does) to enforce.`,
    );
  } else {
    assert(chunkCountB === 0, `org B leaked ${chunkCountB} of org A's chunks`);
    assert(hitsB.length === 0, "org B retrieval returns nothing");
    console.log("✓ tenant isolation enforced — org B retrieves 0 chunks");
  }

  // Cleanup.
  await withServiceRole((c) =>
    c.query("DELETE FROM orgs WHERE slug = ANY($1)", [[slug, slugB]]),
  );
  console.log("✓ cleaned up");
  console.log("\nKB SMOKE OK");
}

main()
  .then(() => closePool())
  .catch(async (err) => {
    console.error("\nKB SMOKE FAILED\n", err);
    await closePool();
    process.exit(1);
  });
