/**
 * Pure transform: raw Fluida punches -> `hr.attendance` intervals.
 *
 * Responsibilities (all of which are testable with no network):
 *  - group punches per employee and per local (Europe/Rome) calendar day
 *  - sort chronologically and pair in->out into attendance intervals
 *  - deduplicate exact-duplicate punches (same instant + direction)
 *  - collapse repeated same-direction punches (double scans)
 *  - pair by chronological position rather than trusting the direction label,
 *    which Fluida sometimes reports out-of-order, inverted, or doubled. Labels
 *    are used only as a same-instant tie-break and to flag the day as anomalous
 *    for HR review (BAB-89). This recovers valid intervals from a mislabeled
 *    sequence instead of emitting a misleading zero-hour record.
 *  - surface incomplete days (dangling in / orphan out) as warnings, never
 *    silently dropping data or fabricating a check-out
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

/** Warning attached to every interval of a day whose labels are untrustworthy. */
const ANOMALY_WARNING =
  "out-of-order / mislabeled punch sequence — paired by time, review needed";

/** Direction sort rank for the same-instant tie-break: in before out before unknown. */
function dirRank(d: ResolvedPunch["direction"]): number {
  return d === "in" ? 0 : d === "out" ? 1 : 2;
}

/** Pair one employee-day's punches into intervals (positional / greedy). */
function pairDay(punches: ResolvedPunch[]): AttendanceInterval[] {
  const employeeId = punches[0].employeeId;
  // Sort by instant; tie-break on direction so two punches at the very same
  // instant pair as in->out, never out->in.
  const sorted = [...punches].sort((a, b) => {
    const dt = a.instant.getTime() - b.instant.getTime();
    return dt !== 0 ? dt : dirRank(a.direction) - dirRank(b.direction);
  });

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

  // 2) Decide whether the day's labels are trustworthy. A coherent day reads
  //    in,out,in,out,... (even index = in). When a *known* label contradicts
  //    its chronological position the directions are out-of-order / inverted /
  //    doubled (the BAB-89 cases), so we stop trusting them and pair purely by
  //    position below. "unknown" labels never count as a conflict.
  const mislabeled = deduped.some(
    (p, i) => p.direction !== "unknown" && p.direction !== expectedAt(i),
  );

  // 3) Greedy positional pairing: (0,1), (2,3), ... regardless of label. This
  //    recovers valid intervals from a scrambled sequence (e.g. Lorenzo's
  //    morning, Tommaso's full day) instead of emitting a 0h record. A trailing
  //    unpaired punch is an orphan: reported for review, never fabricated into a
  //    check-out.
  const intervals: AttendanceInterval[] = [];
  let i = 0;
  for (; i + 1 < deduped.length; i += 2) {
    intervals.push(
      pairInterval(employeeId, deduped[i], deduped[i + 1], mislabeled),
    );
  }
  if (i < deduped.length) {
    const last = deduped[i];
    const iv = openInterval(employeeId, last);
    iv.warnings.push(
      last.direction === "out"
        ? "check-out with no preceding check-in (orphan punch) — review needed"
        : "no check-out for the day (still open / forgotten punch)",
    );
    if (mislabeled) iv.warnings.push(ANOMALY_WARNING);
    intervals.push(iv);
  }
  return intervals;
}

/** Expected direction for a punch at position `i` in a coherent day. */
function expectedAt(i: number): "in" | "out" {
  return i % 2 === 0 ? "in" : "out";
}

/**
 * Build a closed interval from a positional in/out pair. If the pair would be
 * zero-length or inverted (two punches at the same instant), it is surfaced as
 * an open review item instead — a 0h `hr.attendance` is never produced.
 */
function pairInterval(
  employeeId: number,
  inP: ResolvedPunch,
  outP: ResolvedPunch,
  mislabeled: boolean,
): AttendanceInterval {
  const warnings: string[] = [];
  if (mislabeled) warnings.push(ANOMALY_WARNING);
  if (outP.instant.getTime() <= inP.instant.getTime()) {
    warnings.push("zero-length or out-of-order pair — review needed");
    return {
      employeeId,
      checkIn: toOdooUtc(inP.instant),
      checkOut: null,
      warnings,
    };
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
