/**
 * Pure aggregation helpers for the leads dashboard.
 *
 * All bucketing is done in **UTC** off the lead's `createdAt`. That keeps the
 * functions deterministic and easy to unit-test; a business-timezone refinement
 * (Europe/Rome, matching mcp-odoo's report-leads.mjs) is a documented follow-up.
 *
 * Nothing here touches React, the network, or env — it's plain data in, data out.
 */
import type { Lead } from "./types";

export type Granularity = "day" | "week" | "month";

/** An inclusive calendar-date range, each side as `YYYY-MM-DD`. */
export interface DateRange {
  from: string;
  to: string;
}

/** One point on the time axis. */
export interface TimeBucket {
  /** Sort/identity key (e.g. `2026-06-01`, ISO-week Monday, or `2026-06`). */
  key: string;
  /** Short human label for the axis. */
  label: string;
  /** Lead count in this bucket. */
  count: number;
}

/** A single slice of a breakdown dimension (source / stage / type). */
export interface BreakdownSlice {
  label: string;
  count: number;
}

const MS_PER_DAY = 86_400_000;

/** `YYYY-MM-DD` for the UTC date of an ISO timestamp. */
function utcDateKey(iso: string): string {
  return iso.slice(0, 10);
}

/** Parse `YYYY-MM-DD` to the UTC midnight epoch ms. */
export function parseDayUtc(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

/** Epoch ms → `YYYY-MM-DD` (UTC). */
function dayKeyFromMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Monday (ISO week start) for a given `YYYY-MM-DD`, as `YYYY-MM-DD` (UTC). */
function isoWeekMonday(day: string): string {
  const ms = parseDayUtc(day);
  const dow = new Date(ms).getUTCDay(); // 0=Sun..6=Sat
  const deltaToMonday = (dow + 6) % 7; // days since Monday
  return dayKeyFromMs(ms - deltaToMonday * MS_PER_DAY);
}

/** `YYYY-MM` for a given `YYYY-MM-DD`. */
function monthKey(day: string): string {
  return day.slice(0, 7);
}

/** Map a lead's createdAt to its bucket key for the chosen granularity. */
export function bucketKey(iso: string, granularity: Granularity): string {
  const day = utcDateKey(iso);
  switch (granularity) {
    case "day":
      return day;
    case "week":
      return isoWeekMonday(day);
    case "month":
      return monthKey(day);
  }
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** Human axis label for a bucket key. */
function labelFor(key: string, granularity: Granularity): string {
  if (granularity === "month") {
    const [y, m] = key.split("-").map(Number);
    return `${MONTHS[m - 1]} ${y}`;
  }
  // day & week keys are both YYYY-MM-DD
  const [, m, d] = key.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]}`;
}

/** Filter leads to those created within [from, to] inclusive (UTC date compare). */
export function filterByRange(leads: Lead[], range: DateRange): Lead[] {
  return leads.filter((l) => {
    const day = utcDateKey(l.createdAt);
    return day >= range.from && day <= range.to;
  });
}

/**
 * Build an ordered, gap-filled time series across the range.
 * Buckets with zero leads are included so the chart stays continuous.
 */
export function bucketLeads(
  leads: Lead[],
  granularity: Granularity,
  range: DateRange,
): TimeBucket[] {
  const counts = new Map<string, number>();
  for (const l of filterByRange(leads, range)) {
    const k = bucketKey(l.createdAt, granularity);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }

  // Walk the range, emitting one bucket per granularity step.
  const out: TimeBucket[] = [];
  const seen = new Set<string>();
  const endMs = parseDayUtc(range.to);

  if (granularity === "month") {
    let [y, m] = range.from.split("-").map(Number);
    const endKey = monthKey(range.to);
    let key = `${y}-${String(m).padStart(2, "0")}`;
    while (key <= endKey) {
      out.push({
        key,
        label: labelFor(key, granularity),
        count: counts.get(key) ?? 0,
      });
      m += 1;
      if (m > 12) {
        m = 1;
        y += 1;
      }
      key = `${y}-${String(m).padStart(2, "0")}`;
    }
    return out;
  }

  const step = granularity === "week" ? 7 : 1;
  // For weeks, start at the Monday of the range start so buckets line up.
  let cursor =
    granularity === "week"
      ? parseDayUtc(isoWeekMonday(range.from))
      : parseDayUtc(range.from);

  while (cursor <= endMs) {
    const dayKey = dayKeyFromMs(cursor);
    const key = granularity === "week" ? isoWeekMonday(dayKey) : dayKey;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({
        key,
        label: labelFor(key, granularity),
        count: counts.get(key) ?? 0,
      });
    }
    cursor += step * MS_PER_DAY;
  }
  return out;
}

export interface Kpis {
  /** Leads across the entire dataset (all time). */
  totalAllTime: number;
  /** Leads created within the selected range. */
  inPeriod: number;
  /** Leads in the immediately-preceding window of equal length. */
  previousPeriod: number;
  /**
   * Period-over-period change as a fraction (0.25 == +25%).
   * `null` when the previous period had zero leads (no meaningful %).
   */
  periodOverPeriod: number | null;
}

/** Number of inclusive days in a range. */
function rangeDays(range: DateRange): number {
  return (
    Math.round((parseDayUtc(range.to) - parseDayUtc(range.from)) / MS_PER_DAY) +
    1
  );
}

/** The equal-length window ending the day before `range.from`. */
export function previousRange(range: DateRange): DateRange {
  const days = rangeDays(range);
  const prevToMs = parseDayUtc(range.from) - MS_PER_DAY;
  const prevFromMs = prevToMs - (days - 1) * MS_PER_DAY;
  return { from: dayKeyFromMs(prevFromMs), to: dayKeyFromMs(prevToMs) };
}

export function computeKpis(leads: Lead[], range: DateRange): Kpis {
  const inPeriod = filterByRange(leads, range).length;
  const previousPeriod = filterByRange(leads, previousRange(range)).length;
  const periodOverPeriod =
    previousPeriod === 0 ? null : (inPeriod - previousPeriod) / previousPeriod;
  return {
    totalAllTime: leads.length,
    inPeriod,
    previousPeriod,
    periodOverPeriod,
  };
}

/** Count leads grouped by a dimension, within the range, sorted desc. */
export function breakdownBy(
  leads: Lead[],
  dimension: "source" | "stage" | "type",
  range: DateRange,
): BreakdownSlice[] {
  const counts = new Map<string, number>();
  for (const l of filterByRange(leads, range)) {
    const label = l[dimension] || "Unknown";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/** Min/max createdAt date (YYYY-MM-DD) across the dataset, or null if empty. */
export function datasetBounds(leads: Lead[]): DateRange | null {
  if (leads.length === 0) return null;
  let min = utcDateKey(leads[0].createdAt);
  let max = min;
  for (const l of leads) {
    const d = utcDateKey(l.createdAt);
    if (d < min) min = d;
    if (d > max) max = d;
  }
  return { from: min, to: max };
}
