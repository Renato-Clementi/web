/**
 * Fluida -> Odoo sync orchestrator.
 *
 * Flow: read source -> resolve employees -> build attendance + leave ->
 * idempotent upsert into Odoo -> structured report. The whole thing runs
 * against the `FluidaSource` and `OdooHrPort` interfaces, so it is fully
 * testable with in-memory fakes (no network, no credentials).
 *
 * `dryRun` performs every read and computation but no writes — used for
 * verification before the first live cutover.
 */
import { buildAttendance } from "./attendance";
import { buildLeaves } from "./leave";
import { buildResolver } from "./mapping";
import type { OdooHrPort } from "./odoo";
import type { FluidaSource } from "./source";
import type { LogEntry, MappingResult, SyncReport } from "./types";

export interface RunOptions {
  rangeStartIso: string;
  rangeEndIso: string;
  dryRun?: boolean;
  /** Override "now" for deterministic reports/tests. */
  now?: () => Date;
  /** Optional Fluida-label -> hr.leave.type id map override. */
  leaveTypeMap?: Record<string, number>;
}

export async function runSync(
  source: FluidaSource,
  odoo: OdooHrPort,
  opts: RunOptions,
): Promise<SyncReport> {
  const now = opts.now ?? (() => new Date());
  const logs: LogEntry[] = [];
  const log = (
    level: LogEntry["level"],
    message: string,
    context?: Record<string, unknown>,
  ) => logs.push({ level, message, context });

  const startedAt = now().toISOString();
  const dryRun = opts.dryRun ?? false;

  const report: SyncReport = {
    startedAt,
    finishedAt: startedAt,
    dryRun,
    attendance: { created: 0, updated: 0, skipped: 0, incomplete: 0 },
    leave: { created: 0, updated: 0, skipped: 0 },
    unmatched: [],
    incompleteForReview: [],
    logs,
    hadErrors: false,
  };

  try {
    log("info", `Reading from ${source.name}`, {
      from: opts.rangeStartIso,
      to: opts.rangeEndIso,
      dryRun,
    });
    const data = await source.fetch(opts.rangeStartIso, opts.rangeEndIso);
    log("info", "Source read complete", {
      punches: data.punches.length,
      leaves: data.leaves.length,
    });

    const directory = await odoo.listEmployees();
    const resolver = buildResolver(directory);
    log("info", "Loaded employee directory", { employees: directory.length });

    // --- Map punches & leaves to employees ---------------------------------
    const punchMaps: MappingResult[] = data.punches.map((p) =>
      resolver.resolve(p.badge, p.email),
    );
    const leaveMaps: MappingResult[] = data.leaves.map((l) =>
      resolver.resolve(l.badge, l.email),
    );

    for (const m of punchMaps) {
      if (m.employeeId == null) {
        report.unmatched.push({
          badge: m.badge,
          email: m.email,
          kind: "punch",
        });
      }
    }
    for (const m of leaveMaps) {
      if (m.employeeId == null) {
        report.unmatched.push({
          badge: m.badge,
          email: m.email,
          kind: "leave",
        });
      }
    }
    if (report.unmatched.length) {
      log("warn", "Some records could not be mapped to an employee", {
        count: report.unmatched.length,
        sample: report.unmatched.slice(0, 5),
      });
    }

    // --- Attendance ---------------------------------------------------------
    const intervals = buildAttendance(
      data.punches,
      punchMaps.map((m) => m.employeeId),
    );
    for (const iv of intervals) {
      if (iv.warnings.length) {
        report.attendance.incomplete++;
        log("warn", "Attendance interval has warnings", {
          employeeId: iv.employeeId,
          checkIn: iv.checkIn,
          warnings: iv.warnings,
        });
      }
      // A check-out-less (forgotten) punch is never written: Odoo only allows
      // one open attendance per employee, so an open historical record both
      // blocks later attendances and records a shift with no end. Report it for
      // HR to correct in Fluida/Odoo instead of fabricating a check-out.
      if (iv.checkOut === null) {
        report.incompleteForReview.push({
          employeeId: iv.employeeId,
          checkIn: iv.checkIn,
          reason: iv.warnings.join("; ") || "missing check-out",
        });
        continue;
      }
      try {
        const existing = await odoo.findAttendance(iv.employeeId, iv.checkIn);
        if (existing != null) {
          if (dryRun) {
            report.attendance.updated++;
          } else {
            await odoo.updateAttendanceCheckOut(existing, iv.checkOut);
            report.attendance.updated++;
          }
        } else if (dryRun) {
          report.attendance.created++;
        } else {
          await odoo.createAttendance(iv);
          report.attendance.created++;
        }
      } catch (err) {
        report.attendance.skipped++;
        log("error", "Failed to upsert attendance", {
          employeeId: iv.employeeId,
          checkIn: iv.checkIn,
          error: errMsg(err),
        });
      }
    }

    // --- Leave --------------------------------------------------------------
    const { requests, unknownTypes } = buildLeaves(
      data.leaves,
      leaveMaps.map((m) => m.employeeId),
      opts.leaveTypeMap,
    );
    if (unknownTypes.length) {
      log("warn", "Unmapped Fluida leave types (extend the type map)", {
        types: unknownTypes,
      });
    }
    for (const req of requests) {
      try {
        const existing = await odoo.findLeave(
          req.employeeId,
          req.holidayStatusId,
          req.dateFrom,
        );
        if (existing != null) {
          report.leave.skipped++; // already present — leaves are not mutated
        } else if (dryRun) {
          report.leave.created++;
        } else {
          await odoo.createLeave(req);
          report.leave.created++;
        }
      } catch (err) {
        report.leave.skipped++;
        log("error", "Failed to create leave", {
          employeeId: req.employeeId,
          dateFrom: req.dateFrom,
          error: errMsg(err),
        });
      }
    }

    if (report.incompleteForReview.length) {
      log("warn", "Forgotten-checkout punches not written — HR review needed", {
        count: report.incompleteForReview.length,
        items: report.incompleteForReview,
      });
    }

    log("info", "Sync complete", {
      attendance: report.attendance,
      leave: report.leave,
      unmatched: report.unmatched.length,
      incompleteForReview: report.incompleteForReview.length,
    });
  } catch (err) {
    log("error", "Sync aborted with a fatal error", { error: errMsg(err) });
  }

  report.finishedAt = now().toISOString();
  report.hadErrors = logs.some((l) => l.level === "error");
  return report;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
