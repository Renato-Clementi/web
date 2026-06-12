/**
 * GET /api/kb/jobs/{jobId}?orgId=... — poll an ingestion job's status (BAB-17).
 *
 * Returns the ingestion_jobs row (status, progress counters, error). Scoped to
 * the org via RLS (withOrg). Same interim auth as the ingest route: requires
 * INGEST_INTERNAL_KEY + matching x-internal-key header until BAB-16 lands real
 * session auth.
 */
import { NextResponse } from "next/server";
import { withOrg } from "@/lib/db";

export const runtime = "nodejs";

interface JobRow {
  id: string;
  kind: string;
  status: string;
  total_documents: number;
  processed_documents: number;
  total_chunks: number;
  embedded_chunks: number;
  embedding_provider: string | null;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const expected = process.env.INGEST_INTERNAL_KEY?.trim();
  if (!expected) {
    return NextResponse.json(
      {
        error:
          "Ingestion API disabled: set INGEST_INTERNAL_KEY (interim auth until BAB-16).",
      },
      { status: 503 },
    );
  }
  if (req.headers.get("x-internal-key") !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { jobId } = await params;
  const orgId = new URL(req.url).searchParams.get("orgId");
  if (!orgId) {
    return NextResponse.json(
      { error: "orgId query param is required" },
      { status: 400 },
    );
  }

  try {
    const row = await withOrg(orgId, async (c) => {
      const r = await c.query<JobRow>(
        `SELECT id, kind, status, total_documents, processed_documents,
                total_chunks, embedded_chunks, embedding_provider, error,
                started_at, finished_at, created_at
         FROM ingestion_jobs WHERE org_id = $1 AND id = $2`,
        [orgId, jobId],
      );
      return r.rows[0] ?? null;
    });
    if (!row) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }
    return NextResponse.json({ job: row });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
