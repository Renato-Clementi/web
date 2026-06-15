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
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  /** Override the punches path (default `/v1/timbrature`). */
  punchesPath?: string;
  /** Override the leaves path (default `/v1/assenze`). */
  leavesPath?: string;
}

/**
 * Live source. The response-shape normalizers are deliberately lenient (accept
 * several common field names) so we adapt to the portal's actual payload with a
 * config tweak rather than a rewrite once credentials land.
 */
export class FluidaApiSource implements FluidaSource {
  readonly name = "fluida-api";
  constructor(private readonly cfg: FluidaApiConfig) {}

  private async get(
    path: string,
    params: Record<string, string>,
  ): Promise<unknown> {
    const url = new URL(path, this.cfg.baseUrl);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.cfg.timeoutMs ?? 30_000,
    );
    try {
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.cfg.apiKey}`,
          Accept: "application/json",
        },
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(
          `Fluida HTTP ${res.status} ${res.statusText} (${path})`,
        );
      }
      return res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async fetch(
    rangeStartIso: string,
    rangeEndIso: string,
  ): Promise<FluidaExport> {
    const params = { from: rangeStartIso, to: rangeEndIso };
    const [rawPunches, rawLeaves] = await Promise.all([
      this.get(this.cfg.punchesPath ?? "/v1/timbrature", params),
      this.get(this.cfg.leavesPath ?? "/v1/assenze", params),
    ]);
    return {
      punches: asArray(rawPunches).map(normalizeApiPunch),
      leaves: asArray(rawLeaves).map(normalizeApiLeave),
    };
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
  const dirRaw = str(r.direction ?? r.verso ?? r.type)?.toLowerCase();
  const direction: FluidaPunch["direction"] =
    dirRaw === "in" || dirRaw === "entrata" || dirRaw === "entry"
      ? "in"
      : dirRaw === "out" || dirRaw === "uscita" || dirRaw === "exit"
        ? "out"
        : "unknown";
  return {
    badge: str(r.badge ?? r.badgeCode ?? r.matricola ?? r.employeeBadge) ?? "",
    email: str(r.email ?? r.userEmail),
    timestamp: str(r.timestamp ?? r.datetime ?? r.time ?? r.data) ?? "",
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
