/**
 * Server-only reader for live leads from Odoo's `crm.lead` model.
 *
 * This is a small, self-contained Odoo 18 JSON-RPC client (auth via
 * `common.authenticate`, data via `object.execute_kw`), mirroring the mcp-odoo
 * connector but kept inside the web app so the Next.js bundle has no dependency
 * on the MCP package and stays trivially deployable.
 *
 * Credentials come exclusively from env (never hard-coded). When the ODOO_*
 * vars are absent, `loadLiveLeads()` returns null so the caller can fall back
 * to demo data and surface that in the UI.
 *
 * Server-only: this module reads secrets from env and must never be imported
 * into a Client Component.
 */
import type { Lead, LeadType } from "./types";

interface OdooEnv {
  url: string;
  db: string;
  username: string;
  apiKey: string;
  timeoutMs: number;
  maxLimit: number;
}

/** Read ODOO_* env, or return null if the required vars aren't all present. */
function readOdooEnv(): OdooEnv | null {
  const url = process.env.ODOO_URL?.trim().replace(/\/+$/, "");
  const db = process.env.ODOO_DB?.trim();
  const username = process.env.ODOO_USERNAME?.trim();
  const apiKey = process.env.ODOO_API_KEY?.trim();
  if (!url || !db || !username || !apiKey) return null;
  const timeoutMs = Number.parseInt(process.env.ODOO_TIMEOUT_MS ?? "", 10);
  const maxLimit = Number.parseInt(process.env.ODOO_MAX_LIMIT ?? "", 10);
  return {
    url,
    db,
    username,
    apiKey,
    timeoutMs:
      Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30_000,
    maxLimit: Number.isInteger(maxLimit) && maxLimit > 0 ? maxLimit : 5000,
  };
}

interface JsonRpcResponse {
  result?: unknown;
  error?: { message: string; data?: { message?: string; name?: string } };
}

async function rpc(
  env: OdooEnv,
  service: string,
  method: string,
  args: unknown[],
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${env.url}/jsonrpc`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Odoo-Database": env.db,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "call",
        params: { service, method, args },
        id: 1,
      }),
      signal: controller.signal,
      cache: "no-store",
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new Error(`Odoo HTTP ${res.status} ${res.statusText}`);
  }
  const payload = (await res.json()) as JsonRpcResponse;
  if (payload.error) {
    const d = payload.error.data;
    throw new Error(
      `Odoo error: ${d?.message ?? d?.name ?? payload.error.message}`,
    );
  }
  return payload.result;
}

/** Odoo many2one fields arrive as [id, "Display Name"] or false. */
function m2oLabel(v: unknown): string {
  if (Array.isArray(v) && typeof v[1] === "string") return v[1];
  return "Unknown";
}

function normalizeType(v: unknown): LeadType {
  return v === "opportunity" ? "opportunity" : "lead";
}

/** ISO timestamp from Odoo's "YYYY-MM-DD HH:MM:SS" (UTC) create_date. */
function toIso(v: unknown): string | null {
  if (typeof v !== "string" || v.length < 10) return null;
  return v.replace(" ", "T") + "Z";
}

/**
 * Load leads from a live Odoo, or null if ODOO_* isn't configured.
 * Throws (caught by the caller) if Odoo is configured but unreachable.
 */
export async function loadLiveLeads(): Promise<Lead[] | null> {
  const env = readOdooEnv();
  if (!env) return null;

  const uid = await rpc(env, "common", "authenticate", [
    env.db,
    env.username,
    env.apiKey,
    {},
  ]);
  if (typeof uid !== "number" || uid === 0) {
    throw new Error(
      "Odoo authentication failed (check ODOO_DB/USERNAME/API_KEY).",
    );
  }

  const rows = (await rpc(env, "object", "execute_kw", [
    env.db,
    uid,
    env.apiKey,
    "crm.lead",
    "search_read",
    [[]],
    {
      fields: ["source_id", "stage_id", "type", "create_date"],
      order: "create_date asc",
      limit: env.maxLimit,
    },
  ])) as Record<string, unknown>[];

  return rows
    .map((r): Lead | null => {
      const createdAt = toIso(r.create_date);
      if (!createdAt) return null;
      return {
        id: Number(r.id),
        createdAt,
        source: m2oLabel(r.source_id),
        stage: m2oLabel(r.stage_id),
        type: normalizeType(r.type),
      };
    })
    .filter((l): l is Lead => l !== null);
}
