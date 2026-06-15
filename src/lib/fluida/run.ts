/**
 * Schedulable entry point for the Fluida -> Odoo sync (BAB-74).
 *
 * Run nightly or every N minutes via cron / a scheduled job:
 *   tsx src/lib/fluida/run.ts                 # last 24h, live write
 *   tsx src/lib/fluida/run.ts --dry-run       # compute only, no writes
 *   tsx src/lib/fluida/run.ts --since-hours=48
 *   tsx src/lib/fluida/run.ts --from=2026-05-01 --to=2026-05-31 --dry-run
 *                                             # explicit calendar window
 *                                             # (--to is the inclusive last day),
 *                                             # used for monthly back-fills.
 *
 * Source selection:
 *   - FLUIDA_API_KEY set  -> live REST source (FluidaApiSource)
 *   - else                -> CSV fallback, reading FLUIDA_PUNCHES_CSV (path)
 *                            and optional FLUIDA_LEAVES_CSV (path)
 *
 * Emits one JSON line per log entry (machine-parseable for the HR agent,
 * Chronos) plus a final summary line. Exit code is non-zero if any error was
 * logged, so a scheduler marks the run failed.
 */
import { readFile } from "node:fs/promises";
import { OdooHrRpcClient, readOdooEnv } from "./odoo";
import { runSync } from "./pipeline";
import { FluidaApiSource, FluidaCsvSource, type FluidaSource } from "./source";

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
/** Truthy env flag: "1", "true", "yes", "on" (case-insensitive). */
function envFlag(name: string): boolean {
  return ["1", "true", "yes", "on"].includes(
    (process.env[name] ?? "").trim().toLowerCase(),
  );
}

async function buildSource(): Promise<FluidaSource> {
  const apiKey = process.env.FLUIDA_API_KEY?.trim();
  if (apiKey) {
    const companyId = process.env.FLUIDA_COMPANY_ID?.trim();
    if (!companyId) {
      throw new Error(
        "FLUIDA_API_KEY is set but FLUIDA_COMPANY_ID is missing (needed for the {company_id} path segment).",
      );
    }
    return new FluidaApiSource({
      baseUrl: process.env.FLUIDA_API_URL?.trim() || "https://api.fluida.io",
      apiKey,
      companyId,
      // Ferie/permessi are native in Odoo (BAB-90); the leaves endpoint 401s
      // without the (un-granted) "requests" scope, so it stays off unless
      // explicitly opted in. See BAB-93.
      leavesEnabled: envFlag("FLUIDA_LEAVES_ENABLED"),
    });
  }
  const punchesPath = process.env.FLUIDA_PUNCHES_CSV?.trim();
  if (!punchesPath) {
    throw new Error(
      "No source configured: set FLUIDA_API_KEY (live) or FLUIDA_PUNCHES_CSV (fallback export).",
    );
  }
  const leavesPath = process.env.FLUIDA_LEAVES_CSV?.trim();
  const [punchesCsv, leavesCsv] = await Promise.all([
    readFile(punchesPath, "utf8"),
    leavesPath ? readFile(leavesPath, "utf8") : Promise.resolve(""),
  ]);
  return new FluidaCsvSource(punchesCsv, leavesCsv, {
    timeZone: process.env.FLUIDA_TZ || "Europe/Rome",
    leaveColumns: leavesCsv
      ? {
          badge: "badge",
          email: "email",
          leaveType: "leaveType",
          start: "start",
          end: "end",
          approved: "approved",
        }
      : undefined,
  });
}

/** Parse a calendar date (YYYY-MM-DD) as a UTC instant, or throw. */
function parseDate(name: string, value: string, endOfDay: boolean): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`--${name} must be YYYY-MM-DD (got "${value}")`);
  }
  const d = new Date(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`--${name} is not a valid date ("${value}")`);
  }
  return d;
}

async function main(): Promise<void> {
  const dryRun = flag("dry-run");
  const fromArg = arg("from");
  const toArg = arg("to");

  let start: Date;
  let end: Date;
  if (fromArg || toArg) {
    // Explicit calendar window (monthly back-fill). --to is the INCLUSIVE last
    // day: we extend it to 23:59:59.999Z so the source's date-only slice keeps
    // that whole day in range.
    if (!fromArg || !toArg) {
      throw new Error("--from and --to must be supplied together.");
    }
    start = parseDate("from", fromArg, false);
    end = parseDate("to", toArg, true);
    if (start.getTime() > end.getTime()) {
      throw new Error("--from must not be after --to.");
    }
  } else {
    const sinceHours = Number.parseInt(arg("since-hours") ?? "24", 10);
    end = new Date();
    start = new Date(end.getTime() - sinceHours * 3600_000);
  }

  const odooEnv = readOdooEnv();
  if (!odooEnv) {
    console.error(
      JSON.stringify({
        level: "error",
        message:
          "ODOO_* env not configured (ODOO_URL/DB/USERNAME/API_KEY required).",
      }),
    );
    process.exit(2);
  }

  const source = await buildSource();
  const odoo = new OdooHrRpcClient(odooEnv);

  const report = await runSync(source, odoo, {
    rangeStartIso: start.toISOString(),
    rangeEndIso: end.toISOString(),
    dryRun,
  });

  for (const entry of report.logs) {
    const line = JSON.stringify(entry);
    if (entry.level === "error") console.error(line);
    else console.log(line);
  }
  console.log(
    JSON.stringify({
      level: report.hadErrors ? "error" : "info",
      message: "fluida-sync summary",
      context: {
        dryRun: report.dryRun,
        attendance: report.attendance,
        leave: report.leave,
        unmatched: report.unmatched.length,
        incompleteForReview: report.incompleteForReview.length,
      },
    }),
  );
  process.exit(report.hadErrors ? 1 : 0);
}

main().catch((err) => {
  console.error(
    JSON.stringify({
      level: "error",
      message: "fluida-sync crashed",
      context: { error: err instanceof Error ? err.message : String(err) },
    }),
  );
  process.exit(1);
});
