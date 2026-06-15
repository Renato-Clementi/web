/**
 * Fluida data sources.
 *
 * The pipeline depends only on the `FluidaSource` interface, so we can swap the
 * live REST source for a file export (Zucchetti/Excel-as-CSV) or a test fixture
 * without touching the rest of the code.
 *
 *  - `FluidaApiSource`  — Developer Portal REST API. Requires `FLUIDA_API_KEY`
 *    (board-provided secret). Endpoint shapes are configurable because the
 *    portal's exact routes are confirmed only once we have credentials; until
 *    then this path is exercised only against a mocked `fetch`.
 *  - `FluidaCsvSource`  — parses a CSV export (the documented fallback). Pure
 *    and dependency-free (reuses the in-repo CSV parser), so it runs today
 *    without any Fluida credentials.
 */
import { parseCsv } from "../kb/csv";
import { localToInstant } from "./time";
import type { FluidaExport, FluidaLeave, FluidaPunch } from "./types";

export interface FluidaSource {
  /** Pull punches + approved leaves for the given closed-open instant range. */
  fetch(rangeStartIso: string, rangeEndIso: string): Promise<FluidaExport>;
  /** Short label for logs. */
  readonly name: string;
}

// --- REST API source --------------------------------------------------------

export interface FluidaApiConfig {
  /** API base. Default `https://api.fluida.io`. */
  baseUrl?: string;
  /** Fluida app UUID — sent as `x-fluida-app-uuid`. Authenticates + scopes the company. */
  apiKey: string;
  /** Fluida company id (UUID), used in the `{company_id}` path segment. */
  companyId: string;
  /**
   * Fetch approved leaves from `/api/v1/requests/list/{company_id}`.
   * Default `false`: ferie/permessi are managed natively in Odoo (BAB-90) and
   * the Fluida key is not granted the "requests" scope (BAB-87 cancelled), so
   * calling that endpoint only yields a nightly 401 that clutters the logs.
   * Flip on (via `FLUIDA_LEAVES_ENABLED`) only if Fluida later grants the scope.
   */
  leavesEnabled?: boolean;
  timeoutMs?: number;
}

/**
 * Live source against the real Fluida REST API (reverse-engineered from
 * developer.fluida.io). Auth is the `x-fluida-app-uuid` header (NOT Bearer);
 * the key both authenticates and scopes the company.
 *
 * - Punches: `GET /api/v1/stampings/list/{company_id}` — each stamping already
 *   carries `badge_id`, `user_email`, `direction` (IN/OUT) and `server_clock_at`
 *   (an absolute UTC instant), so no separate contracts lookup is needed.
 * - Leaves:  `GET /api/v1/requests/list/{company_id}` — OFF by default
 *   (`leavesEnabled`, see config). Ferie/permessi live natively in Odoo
 *   (BAB-90) and the key lacks the "requests" scope (BAB-87 cancelled), so the
 *   call is skipped entirely to avoid a nightly 401 in the logs. When enabled
 *   it is still best-effort — a 401/403 never aborts the attendance sync.
 */
export class FluidaApiSource implements FluidaSource {
  readonly name = "fluida-api";
  constructor(private readonly cfg: FluidaApiConfig) {}

  private base(): string {
    return (this.cfg.baseUrl ?? "https://api.fluida.io").replace(/\/+$/, "");
  }

  private async get(path: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.cfg.timeoutMs ?? 30_000,
    );
    try {
      return await fetch(`${this.base()}${path}`, {
        headers: {
          "x-fluida-app-uuid": this.cfg.apiKey,
          Accept: "application/json",
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Fluida `*_date` params are calendar dates (YYYY-MM-DD). */
  private static dateOnly(iso: string): string {
    return new Date(iso).toISOString().slice(0, 10);
  }

  async fetch(
    rangeStartIso: string,
    rangeEndIso: string,
  ): Promise<FluidaExport> {
    const from = FluidaApiSource.dateOnly(rangeStartIso);
    const to = FluidaApiSource.dateOnly(rangeEndIso);
    const cid = encodeURIComponent(this.cfg.companyId);
    const range = `from_date=${from}&to_date=${to}`;

    // Punches — required. A non-OK here is a real failure.
    const pRes = await this.get(`/api/v1/stampings/list/${cid}?${range}`);
    if (!pRes.ok) {
      throw new Error(
        `Fluida stampings HTTP ${pRes.status} ${pRes.statusText}`,
      );
    }
    const punches = asArray(await pRes.json()).map(normalizeApiPunch);

    // Leaves — OFF by default (ferie are native in Odoo, see BAB-90/BAB-93).
    // When explicitly enabled it is best-effort: the key may lack the
    // "requests" scope (401/403), in which case we proceed with attendance only.
    let leaves: FluidaLeave[] = [];
    if (this.cfg.leavesEnabled) {
      try {
        const lRes = await this.get(`/api/v1/requests/list/${cid}?${range}`);
        if (lRes.ok) {
          leaves = asArray(await lRes.json()).map(normalizeApiLeave);
        }
      } catch {
        // network/abort — leave `leaves` empty; attendance still syncs
      }
    }
    return { punches, leaves };
  }
}

function asArray(v: unknown): Record<string, unknown>[] {
  if (Array.isArray(v)) return v as Record<string, unknown>[];
  if (v && typeof v === "object") {
    const data =
      (v as { data?: unknown; items?: unknown }).data ??
      (v as { items?: unknown }).items;
    if (Array.isArray(data)) return data as Record<string, unknown>[];
  }
  return [];
}

const str = (v: unknown): string | undefined =>
  v == null ? undefined : String(v);

function normalizeApiPunch(r: Record<string, unknown>): FluidaPunch {
  // Real Fluida stamping fields: direction = "IN"/"OUT".
  const dirRaw = str(r.direction ?? r.verso ?? r.type)?.toLowerCase();
  const direction: FluidaPunch["direction"] =
    dirRaw === "in" || dirRaw === "entrata" || dirRaw === "entry"
      ? "in"
      : dirRaw === "out" || dirRaw === "uscita" || dirRaw === "exit"
        ? "out"
        : "unknown";
  return {
    // `badge_id` is the physical badge → hr.employee.barcode (primary key).
    badge: str(r.badge_id ?? r.badge ?? r.badgeCode ?? r.matricola) ?? "",
    // `user_email` is the fallback match key → hr.employee.work_email.
    email: str(r.user_email ?? r.email ?? r.userEmail),
    // `server_clock_at` is an absolute UTC instant (the punch time).
    timestamp:
      str(r.server_clock_at ?? r.timestamp ?? r.datetime ?? r.time) ?? "",
    direction,
    sourceId: str(r.id ?? r.uuid),
  };
}

function normalizeApiLeave(r: Record<string, unknown>): FluidaLeave {
  const status = str(r.status ?? r.state ?? r.approvalStatus)?.toLowerCase();
  const approved =
    r.approved === true ||
    status === "approved" ||
    status === "approvata" ||
    status === "approvato";
  return {
    badge: str(r.badge ?? r.badgeCode ?? r.matricola) ?? "",
    email: str(r.email ?? r.userEmail),
    leaveType: str(r.leaveType ?? r.type ?? r.tipo ?? r.causale) ?? "",
    start: str(r.start ?? r.from ?? r.dateFrom ?? r.dataInizio) ?? "",
    end: str(r.end ?? r.to ?? r.dateTo ?? r.dataFine) ?? "",
    approved,
    sourceId: str(r.id ?? r.uuid),
  };
}

// --- CSV / Excel-export source ----------------------------------------------

export interface CsvColumnMap {
  badge: string;
  email?: string;
  timestamp: string;
  direction?: string;
}

export interface FluidaCsvConfig {
  /** Local timezone of the naive timestamps in the export. */
  timeZone?: string;
  punchColumns?: CsvColumnMap;
  leaveColumns?: {
    badge: string;
    email?: string;
    leaveType: string;
    start: string;
    end: string;
    approved?: string;
  };
}

const DEFAULT_PUNCH_COLS: CsvColumnMap = {
  badge: "badge",
  email: "email",
  timestamp: "timestamp",
  direction: "direction",
};

/**
 * Parse pre-loaded CSV text (punches + optional leaves). Naive timestamps are
 * interpreted in `timeZone` (default Europe/Rome) and converted to absolute
 * instants. This source is fully usable today without Fluida credentials.
 */
export class FluidaCsvSource implements FluidaSource {
  readonly name = "fluida-csv";
  constructor(
    private readonly punchesCsv: string,
    private readonly leavesCsv: string = "",
    private readonly cfg: FluidaCsvConfig = {},
  ) {}

  // The CSV export is a static file, so the date range is informational only
  // (the caller pre-filters the export); we read everything the file contains.
  async fetch(): Promise<FluidaExport> {
    const tz = this.cfg.timeZone ?? "Europe/Rome";
    const pc = this.cfg.punchColumns ?? DEFAULT_PUNCH_COLS;

    const punches: FluidaPunch[] = parseCsv(this.punchesCsv).map((row) => {
      const dirRaw = pc.direction
        ? row[pc.direction]?.toLowerCase()
        : undefined;
      const direction: FluidaPunch["direction"] =
        dirRaw === "in" || dirRaw === "entrata"
          ? "in"
          : dirRaw === "out" || dirRaw === "uscita"
            ? "out"
            : "unknown";
      return {
        badge: row[pc.badge] ?? "",
        email: pc.email ? row[pc.email] : undefined,
        timestamp: localToInstant(row[pc.timestamp], tz).toISOString(),
        direction,
      };
    });

    let leaves: FluidaLeave[] = [];
    const lc = this.cfg.leaveColumns;
    if (this.leavesCsv.trim() && lc) {
      leaves = parseCsv(this.leavesCsv).map((row) => ({
        badge: row[lc.badge] ?? "",
        email: lc.email ? row[lc.email] : undefined,
        leaveType: row[lc.leaveType] ?? "",
        start: localToInstant(row[lc.start], tz).toISOString(),
        end: localToInstant(row[lc.end], tz).toISOString(),
        approved: lc.approved
          ? ["1", "true", "si", "sì", "approved", "approvata"].includes(
              (row[lc.approved] ?? "").toLowerCase(),
            )
          : true, // exports typically already contain only approved leaves
      }));
    }
    return { punches, leaves };
  }
}
