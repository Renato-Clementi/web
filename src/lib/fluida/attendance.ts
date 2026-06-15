/**
 * Pure transform: raw Fluida punches -> `hr.attendance` intervals.
 *
 * Responsibilities (all of which are testable with no network):
 *  - group punches per employee and per local (Europe/Rome) calendar day
 *  - sort chronologically and pair in->out into attendance intervals
 *  - deduplicate exact-duplicate punches (same instant + direction)
 *  - collapse repeated same-direction punches (double scans)
 *  - infer direction when the source reports `unknown` (alternating)
 *  - surface incomplete days (dangling in / orphan out) as warnings, never
 *    silently dropping data
 *
 * The function is intentionally side-effect free; persistence lives in
 * `odooSync.ts`. Idempotency on re-runs is achieved downstream by keying on
 * (employeeId, checkIn).
 */
import type { AttendanceInterval, FluidaPunch } from "./types";
import { localDateKey, parseInstant, toOdooUtc } from "./time";

/** Two punches within this many milliseconds are treated as the same scan. */
const DUPLICATE_WINDOW_MS = 60_000;

interface ResolvedPunch {
  /** Odoo employee id (already mapped). */
  employeeId: number;
  instant: Date;
  direction: "in" | "out" | "unknown";
  badge: string;
}

/**
 * Build attendance intervals from punches that have already been mapped to
 * Odoo employee ids. `punchEmployeeIds[i]` is the employee for `punches[i]`;
 * entries with a null id are ignored here (the caller reports them as
 * unmatched).
 */
export function buildAttendance(
  punches: FluidaPunch[],
  punchEmployeeIds: (number | null)[],
  timeZone = "Europe/Rome",
): AttendanceInterval[] {
  const resolved: ResolvedPunch[] = [];
  punches.forEach((p, i) => {
    const employeeId = punchEmployeeIds[i];
    if (employeeId == null) return;
    resolved.push({
      employeeId,
      instant: parseInstant(p.timestamp),
      direction: p.direction,
      badge: p.badge,
    });
  });

  // Group by employee + local day so an overnight shift stays within its start
  // day. (A shift that spans midnight is rare for office staff; if it occurs,
  // the dangling-in warning makes it visible rather than mis-paired.)
  const groups = new Map<string, ResolvedPunch[]>();
  for (const r of resolved) {
    const key = `${r.employeeId}|${localDateKey(r.instant, timeZone)}`;
    const arr = groups.get(key);
    if (arr) arr.push(r);
    else groups.set(key, [r]);
  }

  const intervals: AttendanceInterval[] = [];
  for (const group of groups.values()) {
    intervals.push(...pairDay(group));
  }
  // Stable, deterministic ordering for predictable upserts/tests.
  intervals.sort((a, b) =>
    a.employeeId !== b.employeeId
      ? a.employeeId - b.employeeId
      : a.checkIn.localeCompare(b.checkIn),
  );
  return intervals;
}

/** Pair one employee-day's punches into intervals. */
function pairDay(punches: ResolvedPunch[]): AttendanceInterval[] {
  const employeeId = punches[0].employeeId;
  const sorted = [...punches].sort(
    (a, b) => a.instant.getTime() - b.instant.getTime(),
  );

  // 1) Drop exact duplicates (same direction within the dedup window).
  const deduped: ResolvedPunch[] = [];
  for (const p of sorted) {
    const prev = deduped[deduped.length - 1];
    if (
      prev &&
      prev.direction === p.direction &&
      p.instant.getTime() - prev.instant.getTime() <= DUPLICATE_WINDOW_MS
    ) {
      continue; // collapse double scan
    }
    deduped.push(p);
  }

  // 2) Infer unknown directions by alternating, starting with "in".
  let expectIn = true;
  const directed = deduped.map((p) => {
    let dir = p.direction;
    if (dir === "unknown") {
      dir = expectIn ? "in" : "out";
    }
    expectIn = dir === "in" ? false : true;
    return { ...p, direction: dir as "in" | "out" };
  });

  // 3) Walk the sequence pairing in->out.
  const intervals: AttendanceInterval[] = [];
  let open: ResolvedPunch | null = null;
  for (const p of directed) {
    if (p.direction === "in") {
      if (open) {
        // Two ins in a row: close the first as incomplete, start a new one.
        intervals.push(openInterval(employeeId, open));
        intervals[intervals.length - 1].warnings.push(
          "missing check-out before a new check-in (incomplete attendance)",
        );
      }
      open = p;
    } else {
      // direction === "out"
      if (open) {
        intervals.push(closedInterval(employeeId, open, p));
        open = null;
      } else {
        // Orphan out with no preceding in: record a zero-length marker so the
        // data isn't lost, and warn loudly.
        intervals.push({
          employeeId,
          checkIn: toOdooUtc(p.instant),
          checkOut: toOdooUtc(p.instant),
          warnings: [
            "check-out with no preceding check-in (orphan punch) — review needed",
          ],
        });
      }
    }
  }
  if (open) {
    intervals.push(openInterval(employeeId, open));
    intervals[intervals.length - 1].warnings.push(
      "no check-out for the day (still open / forgotten punch)",
    );
  }
  return intervals;
}

function closedInterval(
  employeeId: number,
  inP: ResolvedPunch,
  outP: ResolvedPunch,
): AttendanceInterval {
  const warnings: string[] = [];
  if (outP.instant.getTime() <= inP.instant.getTime()) {
    warnings.push("check-out is not after check-in — review needed");
  }
  return {
    employeeId,
    checkIn: toOdooUtc(inP.instant),
    checkOut: toOdooUtc(outP.instant),
    warnings,
  };
}

function openInterval(
  employeeId: number,
  inP: ResolvedPunch,
): AttendanceInterval {
  return {
    employeeId,
    checkIn: toOdooUtc(inP.instant),
    checkOut: null,
    warnings: [],
  };
}
