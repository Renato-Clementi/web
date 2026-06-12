/**
 * POST /api/kb/ingest — enqueue an async knowledge-ingestion job (BAB-17).
 *
 * Body (JSON):
 *   {
 *     orgId: string,
 *     kind: "docs" | "tickets",
 *     source: { type, name, config? },
 *     // for kind="docs":
 *     documents?: [{ title?, uri?, mimeType?, content }],
 *     // for kind="tickets":
 *     ticketsCsv?: string,
 *     columnMapping?: { ... },
 *     chunkOptions?: { targetTokens?, overlapTokens? }
 *   }
 *
 * Returns 202 with { jobId, knowledgeSourceId }. Processing happens in the
 * background (see src/lib/kb/ingest.ts) — poll GET /api/kb/jobs/{jobId}.
 *
 * AUTH (interim): real session auth + org membership lands in BAB-16. Until
 * then this route is OFF unless INGEST_INTERNAL_KEY is set, and requires a
 * matching `x-internal-key` header. orgId is taken from the trusted caller.
 * Do NOT expose this publicly before BAB-16 wires session-derived org scoping.
 */
import { NextResponse } from "next/server";
import { enqueueIngestion, type IngestOptions } from "@/lib/kb/ingest";
import { ticketsCsvToDocuments } from "@/lib/kb/tickets";
import type { RawDocument } from "@/lib/kb/types";

export const runtime = "nodejs";

function authorized(req: Request): boolean {
  const expected = process.env.INGEST_INTERNAL_KEY?.trim();
  if (!expected) return false; // disabled until configured
  return req.headers.get("x-internal-key") === expected;
}

export async function POST(req: Request) {
  if (!process.env.INGEST_INTERNAL_KEY?.trim()) {
    return NextResponse.json(
      {
        error:
          "Ingestion API disabled: set INGEST_INTERNAL_KEY (interim auth until BAB-16).",
      },
      { status: 503 },
    );
  }
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const orgId = typeof body.orgId === "string" ? body.orgId : null;
  const kind =
    body.kind === "tickets" ? "tickets" : body.kind === "docs" ? "docs" : null;
  const source = body.source as IngestOptions["source"] | undefined;
  if (!orgId || !kind || !source?.type || !source?.name) {
    return NextResponse.json(
      {
        error:
          "orgId, kind ('docs'|'tickets'), and source {type,name} are required",
      },
      { status: 400 },
    );
  }

  let documents: RawDocument[];
  if (kind === "tickets") {
    const csv = typeof body.ticketsCsv === "string" ? body.ticketsCsv : "";
    if (!csv) {
      return NextResponse.json(
        { error: "ticketsCsv is required for kind 'tickets'" },
        { status: 400 },
      );
    }
    documents = ticketsCsvToDocuments(
      csv,
      (body.columnMapping as Record<string, string[]>) ?? {},
    ).documents;
  } else {
    const raw = Array.isArray(body.documents)
      ? (body.documents as RawDocument[])
      : [];
    documents = raw.filter(
      (d) => typeof d?.content === "string" && d.content.trim().length > 0,
    );
  }

  if (documents.length === 0) {
    return NextResponse.json(
      { error: "No ingestable documents in request" },
      { status: 400 },
    );
  }

  try {
    const ids = await enqueueIngestion(orgId, {
      kind,
      source,
      documents,
      chunkOptions:
        (body.chunkOptions as IngestOptions["chunkOptions"]) ?? undefined,
    });
    return NextResponse.json(
      { ...ids, status: "queued", totalDocuments: documents.length },
      { status: 202 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
