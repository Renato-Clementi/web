/**
 * Odoo 18 write port for the HR pipeline.
 *
 * The pipeline depends on the `OdooHrPort` interface only, so tests can supply
 * an in-memory fake. `OdooHrRpcClient` is the production implementation, a thin
 * JSON-RPC client mirroring `src/lib/leads/odoo.ts` (auth via
 * `common.authenticate`, data via `object.execute_kw`). Credentials come from
 * env; nothing is hard-coded or logged.
 *
 * Idempotency: `hr.attendance` is keyed on (employee_id, check_in) and
 * `hr.leave` on (employee_id, holiday_status_id, date_from). Re-running the
 * pipeline over an overlapping window updates rather than duplicates.
 *
 * Server-only: reads secrets from env; never import into a Client Component.
 */
import { normalizeOdooUrl } from "../leads/odoo";
import type { AttendanceInterval, LeaveRequest } from "./types";
import type { EmployeeDirectoryEntry } from "./mapping";

export interface OdooHrPort {
  listEmployees(): Promise<EmployeeDirectoryEntry[]>;
  /** Existing attendance id for (employee, check_in), or null. */
  findAttendance(employeeId: number, checkIn: string): Promise<number | null>;
  createAttendance(interval: AttendanceInterval): Promise<number>;
  updateAttendanceCheckOut(id: number, checkOut: string | null): Promise<void>;
  /** Existing leave id for (employee, type, date_from), or null. */
  findLeave(
    employeeId: number,
    holidayStatusId: number,
    dateFrom: string,
  ): Promise<number | null>;
  createLeave(req: LeaveRequest): Promise<number>;
}

interface OdooEnv {
  url: string;
  db: string;
  username: string;
  apiKey: string;
  timeoutMs: number;
  maxLimit: number;
}

/** Read ODOO_* env, or null if any required var is missing. */
export function readOdooEnv(
  env: NodeJS.ProcessEnv = process.env,
): OdooEnv | null {
  const rawUrl = env.ODOO_URL?.trim();
  const url = rawUrl ? normalizeOdooUrl(rawUrl) : undefined;
  const db = env.ODOO_DB?.trim();
  const username = env.ODOO_USERNAME?.trim() || env.ODOO_USER?.trim();
  const apiKey = env.ODOO_API_KEY?.trim();
  if (!url || !db || !username || !apiKey) return null;
  const timeoutMs = Number.parseInt(env.ODOO_TIMEOUT_MS ?? "", 10);
  const maxLimit = Number.parseInt(env.ODOO_MAX_LIMIT ?? "", 10);
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

export class OdooHrRpcClient implements OdooHrPort {
  private uid: number | null = null;
  constructor(private readonly env: OdooEnv) {}

  private async rpc(
    service: string,
    method: string,
    args: unknown[],
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.env.timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.env.url}/jsonrpc`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-Odoo-Database": this.env.db,
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
    if (!res.ok) throw new Error(`Odoo HTTP ${res.status} ${res.statusText}`);
    const payload = (await res.json()) as JsonRpcResponse;
    if (payload.error) {
      const d = payload.error.data;
      throw new Error(
        `Odoo error: ${d?.message ?? d?.name ?? payload.error.message}`,
      );
    }
    return payload.result;
  }

  private async exec(
    model: string,
    method: string,
    args: unknown[],
    kwargs: Record<string, unknown> = {},
  ): Promise<unknown> {
    if (this.uid == null) {
      const uid = await this.rpc("common", "authenticate", [
        this.env.db,
        this.env.username,
        this.env.apiKey,
        {},
      ]);
      if (typeof uid !== "number" || uid === 0) {
        throw new Error(
          "Odoo authentication failed (check ODOO_DB/USERNAME/API_KEY).",
        );
      }
      this.uid = uid;
    }
    return this.rpc("object", "execute_kw", [
      this.env.db,
      this.uid,
      this.env.apiKey,
      model,
      method,
      args,
      kwargs,
    ]);
  }

  async listEmployees(): Promise<EmployeeDirectoryEntry[]> {
    const rows = (await this.exec("hr.employee", "search_read", [[]], {
      fields: ["id", "barcode", "work_email"],
      limit: this.env.maxLimit,
    })) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: Number(r.id),
      barcode: typeof r.barcode === "string" ? r.barcode : null,
      workEmail: typeof r.work_email === "string" ? r.work_email : null,
    }));
  }

  async findAttendance(
    employeeId: number,
    checkIn: string,
  ): Promise<number | null> {
    const ids = (await this.exec(
      "hr.attendance",
      "search",
      [
        [
          ["employee_id", "=", employeeId],
          ["check_in", "=", checkIn],
        ],
      ],
      { limit: 1 },
    )) as number[];
    return ids.length ? ids[0] : null;
  }

  async createAttendance(interval: AttendanceInterval): Promise<number> {
    const values: Record<string, unknown> = {
      employee_id: interval.employeeId,
      check_in: interval.checkIn,
    };
    if (interval.checkOut) values.check_out = interval.checkOut;
    return (await this.exec("hr.attendance", "create", [values])) as number;
  }

  async updateAttendanceCheckOut(
    id: number,
    checkOut: string | null,
  ): Promise<void> {
    await this.exec("hr.attendance", "write", [[id], { check_out: checkOut }]);
  }

  async findLeave(
    employeeId: number,
    holidayStatusId: number,
    dateFrom: string,
  ): Promise<number | null> {
    const ids = (await this.exec(
      "hr.leave",
      "search",
      [
        [
          ["employee_id", "=", employeeId],
          ["holiday_status_id", "=", holidayStatusId],
          ["date_from", "=", dateFrom],
        ],
      ],
      { limit: 1 },
    )) as number[];
    return ids.length ? ids[0] : null;
  }

  async createLeave(req: LeaveRequest): Promise<number> {
    return (await this.exec("hr.leave", "create", [
      {
        employee_id: req.employeeId,
        holiday_status_id: req.holidayStatusId,
        date_from: req.dateFrom,
        date_to: req.dateTo,
      },
    ])) as number;
  }
}
