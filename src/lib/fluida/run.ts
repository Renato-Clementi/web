/**
 * Schedulable entry point for the Fluida -> Odoo sync (BAB-74).
 *
 * Run nightly or every N minutes via cron / a scheduled job:
 *   tsx src/lib/fluida/run.ts                 # last 24h, live write
 *   tsx src/lib/fluida/run.ts --dry-run       # compute only, no writes
 *   tsx src/lib/fluida/run.ts --since-hours=48
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

async function buildSource(): Promise<FluidaSource> {
  const apiKey = process.env.FLUIDA_API_KEY?.trim();
  if (apiKey) {
    return new FluidaApiSource({
      baseUrl: process.env.FLUIDA_API_URL?.trim() || "https://api.fluida.io",
      apiKey,
      punchesPath: process.env.FLUIDA_PUNCHES_PATH,
      leavesPath: process.env.FLUIDA_LEAVES_PATH,
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

async function main(): Promise<void> {
  const dryRun = flag("dry-run");
  const sinceHours = Number.parseInt(arg("since-hours") ?? "24", 10);
  const end = new Date();
  const start = new Date(end.getTime() - sinceHours * 3600_000);

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
