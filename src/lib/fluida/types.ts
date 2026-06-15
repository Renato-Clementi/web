/**
 * Domain types for the Fluida -> Odoo 18 HR integration (BAB-74).
 *
 * The pipeline reads two kinds of records from Fluida (a clock-in/out timbratura
 * provider) and writes them into Odoo:
 *  - punches (`FluidaPunch`)   -> `hr.attendance`
 *  - approved leaves (`FluidaLeave`) -> `hr.leave`
 *
 * Timestamps in this layer are always **absolute instants** encoded as ISO-8601
 * strings carrying an offset or `Z`. Sources that emit local "naive" wall-clock
 * times (e.g. a Zucchetti/Excel export) are responsible for converting them to
 * absolute instants before handing them to the pipeline (see `time.ts`).
 */

/** A single clock event read from Fluida. */
export interface FluidaPunch {
  /**
   * Physical badge code as configured in Fluida. Matched against
   * `hr.employee.barcode` (the primary mapping key, per BAB-73).
   */
  badge: string;
  /**
   * Email of the Fluida user, used as a secondary match key when `badge`
   * is missing or unmapped. Matched against `hr.employee.work_email`.
   */
  email?: string;
  /** Absolute instant of the punch (ISO-8601 with offset or Z). */
  timestamp: string;
  /**
   * Direction of the punch. When the source cannot provide it (`unknown`),
   * the attendance builder infers in/out by alternating within the day.
   */
  direction: "in" | "out" | "unknown";
  /** Opaque source identifier, kept for traceability/debugging. */
  sourceId?: string;
}

/** An approved absence read from Fluida. */
export interface FluidaLeave {
  badge: string;
  email?: string;
  /** Fluida leave-type label (e.g. "Ferie", "ROL", "Malattia"). */
  leaveType: string;
  /** Inclusive start instant of the leave (ISO-8601). */
  start: string;
  /** Exclusive/inclusive end instant of the leave (ISO-8601). */
  end: string;
  /** True only for leaves already approved in Fluida — we never import drafts. */
  approved: boolean;
  sourceId?: string;
}

/** A record set returned by a `FluidaSource`. */
export interface FluidaExport {
  punches: FluidaPunch[];
  leaves: FluidaLeave[];
}

/**
 * Resolution of one Fluida key (badge/email) to an Odoo `hr.employee`.
 * `employeeId === null` means the record could not be mapped.
 */
export interface MappingResult {
  badge: string;
  email?: string;
  employeeId: number | null;
  /** How the match was made — useful in the operator report. */
  via: "barcode" | "work_email" | "unmatched";
}

/** A computed attendance interval ready to upsert into `hr.attendance`. */
export interface AttendanceInterval {
  employeeId: number;
  /** Odoo-formatted UTC naive datetime: "YYYY-MM-DD HH:MM:SS". */
  checkIn: string;
  /** Same format, or null for an open/incomplete attendance. */
  checkOut: string | null;
  /** Non-fatal anomalies detected while pairing this interval. */
  warnings: string[];
}

/** A computed leave ready to upsert into `hr.leave`. */
export interface LeaveRequest {
  employeeId: number;
  /** Odoo `hr.leave.type` id (resolved from the Fluida label). */
  holidayStatusId: number;
  /** Odoo-formatted UTC naive datetime. */
  dateFrom: string;
  dateTo: string;
}

/** Severity-tagged log line, surfaced to the HR agent (Chronos). */
export interface LogEntry {
  level: "info" | "warn" | "error";
  message: string;
  context?: Record<string, unknown>;
}

/** Aggregate outcome of one pipeline run. */
export interface SyncReport {
  startedAt: string;
  finishedAt: string;
  dryRun: boolean;
  attendance: {
    created: number;
    updated: number;
    skipped: number;
    incomplete: number;
  };
  leave: { created: number; updated: number; skipped: number };
  unmatched: { badge: string; email?: string; kind: "punch" | "leave" }[];
  logs: LogEntry[];
  /** True when at least one error-level log was recorded. */
  hadErrors: boolean;
}
