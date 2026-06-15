/**
 * BAB-91 read-only baseline: what hr.attendance / hr.leave already exists in
 * Odoo for May 2026? Establishes the gap before any Fluida backfill.
 *
 * Read-only: search_read + read_group only. Writes nothing.
 *   tsx scripts/bab91_may_baseline.ts
 */
import { OdooHrRpcClient, readOdooEnv } from "../src/lib/fluida/odoo";

const FROM = "2026-05-01 00:00:00";
const TO = "2026-06-01 00:00:00";

async function main(): Promise<void> {
  const env = readOdooEnv();
  if (!env) throw new Error("ODOO_* env not configured");
  const odoo = new OdooHrRpcClient(env);

  // reuse the client's private exec via a tiny cast (read-only).
  const exec = (
    odoo as unknown as {
      exec: (
        m: string,
        meth: string,
        args: unknown[],
        kw?: Record<string, unknown>,
      ) => Promise<unknown>;
    }
  ).exec.bind(odoo);

  const attCount = (await exec("hr.attendance", "search_count", [
    [
      ["check_in", ">=", FROM],
      ["check_in", "<", TO],
    ],
  ])) as number;
  console.log(`hr.attendance with check_in in May 2026: ${attCount}`);

  if (attCount > 0) {
    const grp = (await exec("hr.attendance", "read_group", [
      [
        ["check_in", ">=", FROM],
        ["check_in", "<", TO],
      ],
      ["worked_hours:sum"],
      ["employee_id"],
    ])) as Record<string, unknown>[];
    console.log("By employee:");
    for (const g of grp) {
      console.log(
        `  emp ${JSON.stringify(g.employee_id)}  count=${g.employee_id_count}  worked_hours=${g.worked_hours}`,
      );
    }
  }

  // leaves overlapping May
  const leaveCount = (await exec("hr.leave", "search_count", [
    [
      ["date_from", "<", TO],
      ["date_to", ">=", FROM],
    ],
  ])) as number;
  console.log(`\nhr.leave overlapping May 2026: ${leaveCount}`);

  // employee directory size (for context)
  const emps = (await exec("hr.employee", "search_count", [
    [["active", "=", true]],
  ])) as number;
  console.log(`active hr.employee: ${emps}`);
}

main().catch((e) => {
  console.error("baseline failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
