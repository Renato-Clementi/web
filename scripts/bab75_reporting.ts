/**
 * BAB-75 Fase 4 — Reporting disponibilità e controllo ore (read-only).
 *
 * Computes, against the LIVE Odoo 18 instance, the report set required by the
 * acceptance criteria, verified on a pilot window (May 2026, the back-filled
 * Fluida data — see BAB-91) plus "today" availability:
 *   1. Presenti oggi              — who clocked in today / still open punch
 *   2. Ore lavorate vs contrattuali (pilot month) + scostamento
 *   3. Disponibilità oggi          — present / on-leave / available
 *   4. Calendario ferie/permessi   — approved upcoming leaves
 *   5. KPI: monte ore, saldo ferie (allocazioni − fruito), scostamenti
 *
 * Read-only: search_read / read_group / search_count only. Writes nothing.
 *   tsx scripts/bab75_reporting.ts [YYYY-MM] [YYYY-MM-DD(today)]
 */
import { OdooHrRpcClient, readOdooEnv } from "../src/lib/fluida/odoo";

type Row = Record<string, unknown>;
type Exec = (
  m: string,
  meth: string,
  args: unknown[],
  kw?: Record<string, unknown>,
) => Promise<unknown>;

function m2(n: number): string {
  return String(n).padStart(2, "0");
}
function monthBounds(ym: string): { from: string; to: string } {
  const [y, mo] = ym.split("-").map((s) => Number.parseInt(s, 10));
  const nextY = mo === 12 ? y + 1 : y;
  const nextM = mo === 12 ? 1 : mo + 1;
  return {
    from: `${y}-${m2(mo)}-01 00:00:00`,
    to: `${nextY}-${m2(nextM)}-01 00:00:00`,
  };
}
function name(v: unknown): string {
  return Array.isArray(v) ? String(v[1]) : String(v);
}
function id(v: unknown): number | null {
  return Array.isArray(v) ? Number(v[0]) : null;
}

async function main(): Promise<void> {
  const ym = process.argv[2] ?? "2026-05";
  const today = process.argv[3] ?? "2026-06-15";
  const env = readOdooEnv();
  if (!env) throw new Error("ODOO_* env not configured");
  const odoo = new OdooHrRpcClient(env);
  const exec = (odoo as unknown as { exec: Exec }).exec.bind(odoo);

  const { from, to } = monthBounds(ym);
  const dayFrom = `${today} 00:00:00`;
  const dayTo = `${today} 23:59:59`;

  console.log(`=== BAB-75 Reporting — pilot month ${ym}, today ${today} ===\n`);

  // ---- Employees + contractual schedule ----
  const emps = (await exec("hr.employee", "search_read", [
    [["active", "=", true]],
  ], {
    fields: ["id", "name", "resource_calendar_id"],
  })) as Row[];
  const empById = new Map<number, Row>();
  for (const e of emps) empById.set(Number(e.id), e);
  console.log(`Dipendenti attivi: ${emps.length}`);

  // contractual hours/week per calendar
  const calIds = [
    ...new Set(emps.map((e) => id(e.resource_calendar_id)).filter((x): x is number => x != null)),
  ];
  const cals = (await exec("resource.calendar", "search_read", [
    [["id", "in", calIds]],
  ], { fields: ["id", "name", "hours_per_day", "full_time_required_hours"] })) as Row[];
  const calById = new Map<number, Row>();
  for (const c of cals) calById.set(Number(c.id), c);
  console.log("Calendari contrattuali:");
  for (const c of cals)
    console.log(
      `  [${c.id}] ${c.name} — ${c.hours_per_day}h/g, full-time ${c.full_time_required_hours}h/sett`,
    );

  // ================= 1. PRESENTI OGGI =================
  console.log(`\n--- 1. PRESENTI OGGI (${today}) ---`);
  const todayAtt = (await exec("hr.attendance", "search_read", [
    [
      ["check_in", ">=", dayFrom],
      ["check_in", "<=", dayTo],
    ],
  ], { fields: ["employee_id", "check_in", "check_out", "worked_hours"] })) as Row[];
  if (!todayAtt.length) console.log("  (nessuna timbratura oggi)");
  for (const a of todayAtt) {
    const open = !a.check_out;
    console.log(
      `  ${name(a.employee_id)} — in ${a.check_in}${open ? "  [IN CORSO]" : `  out ${a.check_out} (${a.worked_hours}h)`}`,
    );
  }

  // ================= 2. ORE LAVORATE vs CONTRATTUALI (pilot) =================
  console.log(`\n--- 2. ORE LAVORATE vs CONTRATTUALI — ${ym} ---`);
  const grp = (await exec("hr.attendance", "read_group", [
    [
      ["check_in", ">=", from],
      ["check_in", "<", to],
    ],
    ["worked_hours:sum"],
    ["employee_id"],
  ])) as Row[];
  // contractual hours for the month = working days in month * hours_per_day
  // working days via resource.calendar are complex; approximate with 8h * worked-day count
  // but report the raw worked total + count; scostamento vs a nominal 168h FT month.
  const workedByEmp = new Map<number, { h: number; cnt: number }>();
  let monteOre = 0;
  for (const g of grp) {
    const eid = id(g.employee_id);
    if (eid == null) continue;
    const h = Number(g.worked_hours) || 0;
    const cnt = Number(g.employee_id_count) || 0;
    workedByEmp.set(eid, { h, cnt });
    monteOre += h;
  }
  // distinct worked days per employee (for a fair contractual comparison)
  const dayGrp = (await exec("hr.attendance", "read_group", [
    [
      ["check_in", ">=", from],
      ["check_in", "<", to],
    ],
    ["worked_hours:sum"],
    ["employee_id", "check_in:day"],
  ], { lazy: false })) as Row[];
  const daysByEmp = new Map<number, number>();
  for (const g of dayGrp) {
    const eid = id(g.employee_id);
    if (eid == null) continue;
    daysByEmp.set(eid, (daysByEmp.get(eid) ?? 0) + 1);
  }
  console.log(
    "  Dipendente".padEnd(28) +
      "Ore lav.".padStart(10) +
      "GG lav.".padStart(9) +
      "Atteso(gg*h)".padStart(14) +
      "Scost.".padStart(10),
  );
  const scostRows: Array<{ name: string; worked: number; days: number; expected: number; delta: number }> = [];
  for (const [eid, w] of [...workedByEmp.entries()].sort((a, b) => b[1].h - a[1].h)) {
    const e = empById.get(eid);
    const cal = e ? calById.get(id(e.resource_calendar_id) ?? -1) : undefined;
    const hpd = cal ? Number(cal.hours_per_day) || 8 : 8;
    const days = daysByEmp.get(eid) ?? 0;
    const expected = days * hpd;
    const delta = w.h - expected;
    const nm = e ? String(e.name) : `emp ${eid}`;
    scostRows.push({ name: nm, worked: w.h, days, expected, delta });
    console.log(
      `  ${nm.slice(0, 26).padEnd(26)}` +
        `${w.h.toFixed(1).padStart(10)}` +
        `${String(days).padStart(9)}` +
        `${expected.toFixed(1).padStart(14)}` +
        `${(delta >= 0 ? "+" : "") + delta.toFixed(1)}`.padStart(10),
    );
  }
  console.log(`  ----`);
  console.log(`  MONTE ORE totale ${ym}: ${monteOre.toFixed(1)}h su ${workedByEmp.size} dipendenti`);

  // ================= 3. DISPONIBILITÀ OGGI =================
  console.log(`\n--- 3. DISPONIBILITÀ OGGI (${today}) ---`);
  const leavesToday = (await exec("hr.leave", "search_read", [
    [
      ["date_from", "<=", dayTo],
      ["date_to", ">=", dayFrom],
      ["state", "=", "validate"],
    ],
  ], { fields: ["employee_id", "holiday_status_id", "date_from", "date_to"] })) as Row[];
  const onLeaveIds = new Set<number>();
  for (const l of leavesToday) {
    const eid = id(l.employee_id);
    if (eid != null) onLeaveIds.add(eid);
    console.log(`  ASSENTE: ${name(l.employee_id)} — ${name(l.holiday_status_id)} (${l.date_from} → ${l.date_to})`);
  }
  const presentIds = new Set<number>();
  for (const a of todayAtt) {
    const eid = id(a.employee_id);
    if (eid != null) presentIds.add(eid);
  }
  if (!leavesToday.length) console.log("  (nessuna assenza approvata oggi)");
  console.log(`  Presenti (timbrati) oggi: ${presentIds.size}`);
  const availCnt = emps.filter((e) => !onLeaveIds.has(Number(e.id))).length;
  console.log(`  Disponibili (non in ferie/permesso): ${availCnt} / ${emps.length}`);

  // ================= 4. CALENDARIO FERIE/PERMESSI PREVISTI =================
  console.log(`\n--- 4. CALENDARIO FERIE/PERMESSI PREVISTI (da oggi) ---`);
  const upcoming = (await exec("hr.leave", "search_read", [
    [
      ["date_from", ">=", dayFrom],
      ["state", "=", "validate"],
    ],
  ], { fields: ["employee_id", "holiday_status_id", "date_from", "date_to", "number_of_days"], order: "date_from asc", limit: 50 })) as Row[];
  if (!upcoming.length) console.log("  (nessuna assenza approvata futura)");
  for (const l of upcoming)
    console.log(
      `  ${String(l.date_from).slice(0, 10)} → ${String(l.date_to).slice(0, 10)}  ${name(l.employee_id)} — ${name(l.holiday_status_id)} (${l.number_of_days}gg)`,
    );

  // ================= 5. SALDO FERIE (KPI) =================
  console.log(`\n--- 5. SALDO FERIE / PERMESSI (allocazioni − fruito) ---`);
  const allocs = (await exec("hr.leave.allocation", "read_group", [
    [["state", "=", "validate"]],
    ["number_of_days:sum"],
    ["employee_id", "holiday_status_id"],
  ], { lazy: false })) as Row[];
  const taken = (await exec("hr.leave", "read_group", [
    [["state", "=", "validate"]],
    ["number_of_days:sum"],
    ["employee_id", "holiday_status_id"],
  ], { lazy: false })) as Row[];
  const key = (e: number | null, t: number | null) => `${e}|${t}`;
  const allocMap = new Map<string, number>();
  for (const g of allocs)
    allocMap.set(key(id(g.employee_id), id(g.holiday_status_id)), Number(g.number_of_days) || 0);
  const takenMap = new Map<string, number>();
  for (const g of taken)
    takenMap.set(key(id(g.employee_id), id(g.holiday_status_id)), Number(g.number_of_days) || 0);
  // sum saldo per leave type across all employees as a KPI snapshot
  const byType = new Map<string, { alloc: number; taken: number }>();
  for (const [k, v] of allocMap) {
    const tname = k.split("|")[1];
    const cur = byType.get(tname) ?? { alloc: 0, taken: 0 };
    cur.alloc += v;
    byType.set(tname, cur);
  }
  for (const [k, v] of takenMap) {
    const tname = k.split("|")[1];
    const cur = byType.get(tname) ?? { alloc: 0, taken: 0 };
    cur.taken += v;
    byType.set(tname, cur);
  }
  // resolve type names
  const typeIds = [...new Set([...byType.keys()].map((s) => Number(s)).filter((n) => !Number.isNaN(n)))];
  const types = (await exec("hr.leave.type", "search_read", [
    [["id", "in", typeIds]],
  ], { fields: ["id", "name"] })) as Row[];
  const typeName = new Map<number, string>();
  for (const t of types) typeName.set(Number(t.id), String(t.name));
  console.log("  Per tipo (tutti i dipendenti):");
  for (const [k, v] of byType) {
    const tn = typeName.get(Number(k)) ?? `type ${k}`;
    console.log(`    ${tn.padEnd(28)} alloc ${v.alloc.toFixed(1).padStart(8)}  fruito ${v.taken.toFixed(1).padStart(8)}  saldo ${(v.alloc - v.taken).toFixed(1).padStart(8)}`);
  }

  console.log(`\n=== fine report ===`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
