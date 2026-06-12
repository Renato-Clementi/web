#!/usr/bin/env node
/**
 * Report crm.lead records created on a given calendar day (default: yesterday)
 * in the business timezone, via the Odoo JSON-RPC connector.
 *
 * Repeatable / automatable: it reads the same ODOO_* env vars as the MCP server
 * and reuses the connector's OdooClient. No credentials are hard-coded.
 *
 * Usage:
 *   node scripts/report-leads.mjs [--days-ago N] [--tz Europe/Rome] [--out report.csv]
 *
 * Env (required):
 *   ODOO_URL, ODOO_DB, ODOO_USERNAME, ODOO_API_KEY
 * Env (optional):
 *   REPORT_TZ        business timezone for the calendar day (default Europe/Rome)
 *   ODOO_TIMEOUT_MS, ODOO_MAX_LIMIT  (see connector config)
 *
 * Notes:
 *   - Odoo stores datetimes in UTC. We compute the UTC instants that bound the
 *     local business day [00:00:00, next-day 00:00:00) and filter create_date
 *     with `>=` / `<` so the boundary is half-open (no double counting).
 *   - crm.lead covers both leads and opportunities (type in lead/opportunity).
 */
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { writeFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, "..", "dist");
const { loadConfig } = await import(join(distDir, "config.js"));
const { OdooClient } = await import(join(distDir, "odooClient.js"));

// ---- args ----------------------------------------------------------------
function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const daysAgo = Number.parseInt(arg("--days-ago", "1"), 10);
const tz = arg("--tz", process.env.REPORT_TZ || "Europe/Rome");
const outPath = resolve(arg("--out", "leads-report.csv"));

// ---- timezone-aware day bounds -------------------------------------------
/** Offset (ms) of `tz` from UTC at the given UTC instant. */
function tzOffsetMs(timeZone, instantMs) {
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
  const p = Object.fromEntries(
    dtf.formatToParts(new Date(instantMs)).map((x) => [x.type, x.value]),
  );
  const hour = p.hour === "24" ? 0 : Number(p.hour);
  const asUTC = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    hour,
    Number(p.minute),
    Number(p.second),
  );
  return asUTC - instantMs;
}

/** UTC instant for a wall-clock time in `tz` (DST-safe, refined once). */
function wallToUtc(timeZone, y, m, d, hh = 0, mm = 0, ss = 0) {
  const guess = Date.UTC(y, m - 1, d, hh, mm, ss);
  let off = tzOffsetMs(timeZone, guess);
  let utc = guess - off;
  const off2 = tzOffsetMs(timeZone, utc);
  if (off2 !== off) utc = guess - off2;
  return utc;
}

/** Today's calendar date in `tz`. */
function todayInTz(timeZone) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(new Date())
      .map((x) => [x.type, x.value]),
  );
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day) };
}

// Target day = today - daysAgo (calendar arithmetic via UTC midday to avoid DST drift).
const t = todayInTz(tz);
const target = new Date(Date.UTC(t.y, t.m - 1, t.d - daysAgo, 12));
const Y = target.getUTCFullYear();
const M = target.getUTCMonth() + 1;
const D = target.getUTCDate();

const startUtc = wallToUtc(tz, Y, M, D, 0, 0, 0);
const endUtc = wallToUtc(tz, Y, M, D + 1, 0, 0, 0);

const fmtOdoo = (ms) =>
  new Date(ms).toISOString().slice(0, 19).replace("T", " "); // "YYYY-MM-DD HH:MM:SS" UTC
const dayLabel = `${Y}-${String(M).padStart(2, "0")}-${String(D).padStart(2, "0")}`;
const startStr = fmtOdoo(startUtc);
const endStr = fmtOdoo(endUtc);

// ---- fetch ---------------------------------------------------------------
const FIELDS = [
  "name",
  "contact_name",
  "partner_name",
  "email_from",
  "phone",
  "source_id",
  "user_id",
  "stage_id",
  "type",
  "create_date",
];

let cfg;
try {
  cfg = loadConfig();
} catch (err) {
  console.error("ERROR: " + err.message);
  console.error(
    "\nThis report needs a live Odoo connection. Missing config above.",
  );
  process.exit(2);
}

const client = new OdooClient(cfg);
const domain = [
  ["create_date", ">=", startStr],
  ["create_date", "<", endStr],
];

const rows = await client.searchRead("crm.lead", domain, {
  fields: FIELDS,
  order: "create_date asc",
  limit: cfg.maxLimit,
});

// ---- output --------------------------------------------------------------
// Odoo many2one fields come back as [id, "Display Name"] or false.
const m2o = (v) => (Array.isArray(v) ? v[1] : "");
const val = (v) => (v === false || v == null ? "" : String(v));

const HEADERS = [
  "id",
  "name",
  "contact_name",
  "company",
  "email",
  "phone",
  "source",
  "salesperson",
  "stage",
  "type",
  "create_date_utc",
];
const csvCell = (s) => {
  const str = String(s ?? "");
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
};
const csvLines = [HEADERS.join(",")];
for (const r of rows) {
  csvLines.push(
    [
      r.id,
      val(r.name),
      val(r.contact_name),
      val(r.partner_name),
      val(r.email_from),
      val(r.phone),
      m2o(r.source_id),
      m2o(r.user_id),
      m2o(r.stage_id),
      val(r.type),
      val(r.create_date),
    ]
      .map(csvCell)
      .join(","),
  );
}
writeFileSync(outPath, csvLines.join("\n") + "\n");

// Markdown summary to stdout.
const mdEsc = (s) => String(s ?? "").replace(/\|/g, "\\|");
console.log(`# Lead/Opportunità CRM — ${dayLabel} (${tz})`);
console.log("");
console.log(
  `Finestra UTC interrogata: \`create_date >= ${startStr}\` e \`create_date < ${endStr}\`.`,
);
console.log("");
console.log(`**Totale lead create: ${rows.length}**`);
console.log("");
if (rows.length) {
  console.log(
    "| # | Nome | Contatto/Azienda | Email | Telefono | Fonte | Commerciale | Stage | Creato (UTC) |",
  );
  console.log(
    "|---|------|------------------|-------|----------|-------|-------------|-------|--------------|",
  );
  rows.forEach((r, i) => {
    const contact = [val(r.contact_name), val(r.partner_name)]
      .filter(Boolean)
      .join(" / ");
    console.log(
      `| ${i + 1} | ${mdEsc(r.name)} | ${mdEsc(contact)} | ${mdEsc(val(r.email_from))} | ${mdEsc(val(r.phone))} | ${mdEsc(m2o(r.source_id))} | ${mdEsc(m2o(r.user_id))} | ${mdEsc(m2o(r.stage_id))} | ${mdEsc(val(r.create_date))} |`,
    );
  });
} else {
  console.log("_Nessuna lead creata nella finestra indicata._");
}
console.log("");
console.log(`CSV scritto in: ${outPath}`);
