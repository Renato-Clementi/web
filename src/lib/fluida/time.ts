/**
 * Time helpers for the Fluida -> Odoo pipeline (dependency-free).
 *
 * Odoo stores datetimes as **naive UTC** strings ("YYYY-MM-DD HH:MM:SS"); the
 * web client renders them back in the user's timezone. So everything we write
 * must be converted to UTC first. Fluida's API returns ISO-8601 instants with
 * an offset (easy), but file exports (Zucchetti/Excel) carry local wall-clock
 * times with no offset, so we provide a correct, DST-aware Rome->UTC converter
 * built on `Intl` (no moment/luxon dependency).
 */

/** Format an absolute instant as Odoo's naive-UTC datetime string. */
export function toOdooUtc(instant: Date): string {
  if (Number.isNaN(instant.getTime())) {
    throw new Error("toOdooUtc: invalid Date");
  }
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${instant.getUTCFullYear()}-${p(instant.getUTCMonth() + 1)}-${p(instant.getUTCDate())} ` +
    `${p(instant.getUTCHours())}:${p(instant.getUTCMinutes())}:${p(instant.getUTCSeconds())}`
  );
}

/** Parse an ISO-8601 instant (with offset/Z) into a Date, or throw. */
export function parseInstant(iso: string): Date {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Unparseable timestamp: "${iso}"`);
  }
  return d;
}

/**
 * Compute the UTC offset (in minutes) that the given IANA `timeZone` was at,
 * for a particular absolute instant. Positive means ahead of UTC (Rome is +60
 * in winter, +120 in summer).
 */
function zoneOffsetMinutes(instant: Date, timeZone: string): number {
  // Render the instant's wall-clock in the target zone, then diff against the
  // same fields interpreted as UTC. This is the standard Intl trick and is
  // correct across DST boundaries.
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  // Note: Intl may emit hour "24" at midnight; normalize to 0.
  const hour = get("hour") % 24;
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    hour,
    get("minute"),
    get("second"),
  );
  return Math.round((asUtc - instant.getTime()) / 60000);
}

/**
 * Convert a local "naive" wall-clock time in a given zone to an absolute Date.
 *
 * Accepts "YYYY-MM-DD HH:MM[:SS]" (space or `T` separator). DST-correct: we
 * resolve the offset iteratively because the offset itself depends on the
 * instant we're trying to find. Two passes converge for every case except the
 * one ambiguous/skipped hour at a DST transition, where either side is
 * acceptable for attendance purposes.
 */
export function localToInstant(naive: string, timeZone = "Europe/Rome"): Date {
  const m = naive
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) {
    throw new Error(`Unparseable local datetime: "${naive}"`);
  }
  const [, y, mo, d, h, mi, s] = m;
  const fields = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s ?? "0"),
  );
  // First guess: treat the wall-clock as UTC, then back out the zone offset at
  // that instant; refine once using the offset at the corrected instant.
  let guess = fields - zoneOffsetMinutes(new Date(fields), timeZone) * 60000;
  const refinedOffset = zoneOffsetMinutes(new Date(guess), timeZone);
  guess = fields - refinedOffset * 60000;
  return new Date(guess);
}

/** The local calendar date ("YYYY-MM-DD") of an instant in the given zone. */
export function localDateKey(instant: Date, timeZone = "Europe/Rome"): string {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return dtf.format(instant); // en-CA yields YYYY-MM-DD
}
