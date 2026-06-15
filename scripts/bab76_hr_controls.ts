/**
 * BAB-76 Fase 5 — Operatività continua HR: controllo anomalie ricorrente
 * (read-only).
 *
 * Sits on TOP of the engineering-owned nightly Fluida->Odoo sync (BAB-74,
 * routine 76c472f8): that pipeline LOADS hr.attendance and flags
 * incompleteForReview at ingest time. This script is the HR-facing CONTROL that
 * runs against the LIVE Odoo state and DETECTS + SIGNALS anomalies an operator
 * must act on, plus the steady-state KPIs (controllo ore, saldi, disponibilità).
 *
 * Anomaly classes detected:
 *   A. Timbrature aperte di giorni passati (forgotten check-out) — open punch
 *      whose check_in is before "today" (today's open punch = person at work,
 *      not an anomaly).
 *   B. Timbrature degeneri ~0h — closed punch with worked_hours <= ZERO_H
 *      (scrambled/double punches, e.g. BAB-89 id42/id99).
 *   C. Giorni lavorativi senza timbratura né assenza — for each CLOCKING
 *      employee (>=1 punch in window), Mon-Fri days with NO attendance AND NO
 *      approved leave = probable missing punch to chase. Company-closure days
 *      (a weekday where NO clocker punched: holidays/ponti, e.g. 02/06 Festa
 *      della Repubblica) are auto-excluded. Non-clocking staff (badge-less
 *      office/admin, e.g. the Odoo Administrator account) are reported
 *      separately, not as per-day anomalies.
 *
 * Steady-state controls (not anomalies, but the recurring report payload):
 *   - Controllo ore: worked vs expected (gg lavorati * hours_per_day) in window.
 *   - Saldi ferie/permessi: allocazioni - fruito per tipo; flag saldo negativo.
 *   - Disponibilità oggi: presenti / in ferie-permesso / disponibili.
 *
 * Read-only: search_read / read_group / search_count only. Writes nothing.
 *
 *   tsx scripts/bab76_hr_controls.ts [--days=7] [--today=YYYY-MM-DD]
 *
 * Defaults to the real current date and the trailing 7 calendar days. Emits a
 * human report on stdout and, as the LAST line, one machine-parseable JSON
 * object `{"bab76_anomaly_summary": {...}}` so a routine run-issue / scheduler
 * can record counts and decide whether to escalate.
 */
import { OdooHrRpcClient, readOdooEnv } from "../src/lib/fluida/odoo";

type Row = Record<string, unknown>;
type Exec = (
  m: string,
  meth: string,
  args: unknown[],
  kw?: Record<string, unknown>,
) => Promise<unknown>;

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : undefined;
}
function name(v: unknown): string {
  return Array.isArray(v) ? String(v[1]) : String(v);
}
function id(v: unknown): number | null {
  return Array.isArray(v) ? Number(v[0]) : null;
}
function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}
/** Inclusive list of YYYY-MM-DD for [from, to]. */
function dateRange(from: Date, to: Date): string[] {
  const out: string[] = [];
  const cur = new Date(from.getTime());
  while (cur.getTime() <= to.getTime()) {
    out.push(ymd(cur));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}
/** Mon-Fri (UTC) — proxy for a working day on the 40h/5-day calendar. */
function isWeekday(isoDate: string): boolean {
  const dow = new Date(`${isoDate}T00:00:00Z`).getUTCDay();
  return dow >= 1 && dow <= 5;
}

const ZERO_H = 0.1;

async function main(): Promise<void> {
  const env = readOdooEnv();
  if (!env) throw new Error("ODOO_* env not configured");
  const odoo = new OdooHrRpcClient(env);
  const exec = (odoo as unknown as { exec: Exec }).exec.bind(odoo);

  const todayStr = arg("today") ?? ymd(new Date());
  const days = Number.parseInt(arg("days") ?? "7", 10);
  const today = new Date(`${todayStr}T00:00:00Z`);
  const winStart = new Date(today.getTime() - (days - 1) * 86_400_000);
  const winFrom = `${ymd(winStart)} 00:00:00`;
  const winTo = `${todayStr} 23:59:59`;
  const dayFrom = `${todayStr} 00:00:00`;
  const dayTo = `${todayStr} 23:59:59`;

  console.log(
    `=== BAB-76 Controlli HR — finestra ${ymd(winStart)}..${todayStr} (${days}gg), oggi ${todayStr} ===\n`,
  );

  // ---- Employees + contractual schedule ----
  const emps = (await exec(
    "hr.employee",
    "search_read",
    [[["active", "=", true]]],
    { fields: ["id", "name", "resource_calendar_id"] },
  )) as Row[];
  const empById = new Map<number, Row>();
  for (const e of emps) empById.set(Number(e.id), e);
  const calIds = [
    ...new Set(
      emps
        .map((e) => id(e.resource_calendar_id))
        .filter((x): x is number => x != null),
    ),
  ];
  const cals = (await exec(
    "resource.calendar",
    "search_read",
    [[["id", "in", calIds]]],
    { fields: ["id", "name", "hours_per_day"] },
  )) as Row[];
  const hpdByCal = new Map<number, number>();
  for (const c of cals)
    hpdByCal.set(Number(c.id), Number(c.hours_per_day) || 8);
  console.log(`Dipendenti attivi: ${emps.length}`);

  // ---- All attendance in window (one fetch, reused) ----
  const att = (await exec(
    "hr.attendance",
    "search_read",
    [
      [
        ["check_in", ">=", winFrom],
        ["check_in", "<=", winTo],
      ],
    ],
    {
      fields: ["id", "employee_id", "check_in", "check_out", "worked_hours"],
      order: "check_in asc",
    },
  )) as Row[];

  // ---- Approved leaves overlapping window ----
  const leaves = (await exec(
    "hr.leave",
    "search_read",
    [
      [
        ["date_from", "<=", winTo],
        ["date_to", ">=", winFrom],
        ["state", "=", "validate"],
      ],
    ],
    {
      fields: ["employee_id", "holiday_status_id", "date_from", "date_to"],
    },
  )) as Row[];
  // employee -> set of YYYY-MM-DD covered by an approved leave
  const leaveDaysByEmp = new Map<number, Set<string>>();
  for (const l of leaves) {
    const eid = id(l.employee_id);
    if (eid == null) continue;
    const lf = new Date(`${String(l.date_from).slice(0, 10)}T00:00:00Z`);
    const lt = new Date(`${String(l.date_to).slice(0, 10)}T00:00:00Z`);
    const set = leaveDaysByEmp.get(eid) ?? new Set<string>();
    for (const d of dateRange(lf, lt)) set.add(d);
    leaveDaysByEmp.set(eid, set);
  }

  const winDays = dateRange(winStart, today);
  const winWeekdays = winDays.filter(isWeekday);

  // ============== A. TIMBRATURE APERTE GIORNI PASSATI ==============
  console.log(
    `\n--- A. Timbrature APERTE di giorni passati (forgotten check-out) ---`,
  );
  const openPriorDay: Row[] = [];
  for (const a of att) {
    if (a.check_out) continue;
    const ci = String(a.check_in).slice(0, 10);
    if (ci < todayStr) openPriorDay.push(a);
  }
  if (!openPriorDay.length) console.log("  nessuna");
  for (const a of openPriorDay) {
    console.log(
      `  [att ${a.id}] ${name(a.employee_id)} — IN ${a.check_in} (mai chiusa)`,
    );
  }

  // ============== B. TIMBRATURE DEGENERI ~0h ==============
  console.log(`\n--- B. Timbrature chiuse ~0h (worked_hours <= ${ZERO_H}) ---`);
  const zeroHour = att.filter(
    (a) => a.check_out && (Number(a.worked_hours) || 0) <= ZERO_H,
  );
  if (!zeroHour.length) console.log("  nessuna");
  for (const a of zeroHour) {
    console.log(
      `  [att ${a.id}] ${name(a.employee_id)} — ${a.check_in} → ${a.check_out} (${a.worked_hours}h)`,
    );
  }

  // employee -> set of days with at least one attendance
  const attDaysByEmp = new Map<number, Set<string>>();
  for (const a of att) {
    const eid = id(a.employee_id);
    if (eid == null) continue;
    const d = String(a.check_in).slice(0, 10);
    const set = attDaysByEmp.get(eid) ?? new Set<string>();
    set.add(d);
    attDaysByEmp.set(eid, set);
  }
  // Clockers = employees who punched at least once in the window. Only these
  // are subject to per-day missing-punch checks; the rest are badge-less staff.
  const clockerIds = new Set<number>(
    [...attDaysByEmp.entries()]
      .filter(([, s]) => s.size > 0)
      .map(([eid]) => eid),
  );
  const nonClockers = emps
    .filter((e) => !clockerIds.has(Number(e.id)))
    .map((e) => String(e.name));
  // Company-closure days: weekdays (excl. today) where NO clocker punched =
  // holiday / ponte / company-wide closure -> excluded from Class C.
  const closureDays = winWeekdays.filter(
    (d) =>
      d !== todayStr &&
      ![...clockerIds].some((eid) =>
        (attDaysByEmp.get(eid) ?? new Set()).has(d),
      ),
  );
  const closureSet = new Set(closureDays);

  console.log(
    `\n--- C. Giorni feriali senza timbratura né assenza (solo dipendenti timbranti) ---`,
  );
  const missing: Array<{ emp: string; eid: number; days: string[] }> = [];
  for (const eid of clockerIds) {
    const e = empById.get(eid);
    const attDays = attDaysByEmp.get(eid) ?? new Set<string>();
    const leaveD = leaveDaysByEmp.get(eid) ?? new Set<string>();
    const gaps = winWeekdays.filter(
      (d) =>
        d !== todayStr &&
        !closureSet.has(d) &&
        !attDays.has(d) &&
        !leaveD.has(d),
    );
    if (gaps.length)
      missing.push({ emp: e ? String(e.name) : `emp ${eid}`, eid, days: gaps });
  }
  missing.sort((a, b) => b.days.length - a.days.length);
  if (!missing.length) console.log("  nessuno");
  for (const m of missing) {
    console.log(
      `  ${m.emp.slice(0, 28).padEnd(28)} ${m.days.length}gg: ${m.days.join(", ")}`,
    );
  }
  console.log(
    `  Giorni di chiusura aziendale auto-esclusi: ${closureDays.length ? closureDays.join(", ") : "nessuno"}`,
  );
  console.log(
    `  Staff NON timbrante nel periodo (badge-less / da verificare): ${nonClockers.length ? nonClockers.join(", ") : "nessuno"}`,
  );
  console.log(
    `  (nota: oggi ${todayStr} escluso; weekend esclusi; calendario reale per-giorno non modellato → da confermare con responsabile)`,
  );

  // ============== Controllo ore (window) ==============
  console.log(
    `\n--- Controllo ore — finestra ${ymd(winStart)}..${todayStr} ---`,
  );
  const grp = (await exec(
    "hr.attendance",
    "read_group",
    [
      [
        ["check_in", ">=", winFrom],
        ["check_in", "<=", winTo],
      ],
      ["worked_hours:sum"],
      ["employee_id"],
    ],
    { lazy: false },
  )) as Row[];
  let monteOre = 0;
  const oreRows: Array<{
    name: string;
    worked: number;
    days: number;
    expected: number;
  }> = [];
  for (const g of grp) {
    const eid = id(g.employee_id);
    if (eid == null) continue;
    const h = Number(g.worked_hours) || 0;
    monteOre += h;
    const e = empById.get(eid);
    const hpd = e ? (hpdByCal.get(id(e.resource_calendar_id) ?? -1) ?? 8) : 8;
    const workedDays = (attDaysByEmp.get(eid) ?? new Set()).size;
    oreRows.push({
      name: e ? String(e.name) : `emp ${eid}`,
      worked: h,
      days: workedDays,
      expected: workedDays * hpd,
    });
  }
  oreRows.sort((a, b) => b.worked - a.worked);
  console.log(
    "  Dipendente".padEnd(28) +
      "Ore".padStart(9) +
      "GG".padStart(5) +
      "Atteso".padStart(9) +
      "Scost.".padStart(9),
  );
  for (const r of oreRows) {
    const delta = r.worked - r.expected;
    console.log(
      `  ${r.name.slice(0, 26).padEnd(26)}${r.worked.toFixed(1).padStart(9)}${String(r.days).padStart(5)}${r.expected.toFixed(1).padStart(9)}${((delta >= 0 ? "+" : "") + delta.toFixed(1)).padStart(9)}`,
    );
  }
  console.log(
    `  ---- MONTE ORE finestra: ${monteOre.toFixed(1)}h su ${oreRows.length} dip.`,
  );

  // ============== Disponibilità oggi ==============
  console.log(`\n--- Disponibilità oggi (${todayStr}) ---`);
  const todayAtt = att.filter(
    (a) => String(a.check_in).slice(0, 10) === todayStr,
  );
  const presentIds = new Set<number>();
  for (const a of todayAtt) {
    const eid = id(a.employee_id);
    if (eid != null) presentIds.add(eid);
  }
  const onLeaveToday = (await exec(
    "hr.leave",
    "search_read",
    [
      [
        ["date_from", "<=", dayTo],
        ["date_to", ">=", dayFrom],
        ["state", "=", "validate"],
      ],
    ],
    { fields: ["employee_id", "holiday_status_id"] },
  )) as Row[];
  const onLeaveIds = new Set<number>();
  for (const l of onLeaveToday) {
    const eid = id(l.employee_id);
    if (eid != null) onLeaveIds.add(eid);
    console.log(
      `  ASSENTE: ${name(l.employee_id)} — ${name(l.holiday_status_id)}`,
    );
  }
  console.log(`  Presenti (timbrati) oggi: ${presentIds.size}`);
  console.log(
    `  Disponibili (non in ferie/permesso): ${emps.filter((e) => !onLeaveIds.has(Number(e.id))).length} / ${emps.length}`,
  );

  // ============== Saldi ferie/permessi ==============
  console.log(
    `\n--- Saldi ferie/permessi (allocazioni − fruito, per tipo) ---`,
  );
  const allocs = (await exec(
    "hr.leave.allocation",
    "read_group",
    [
      [["state", "=", "validate"]],
      ["number_of_days:sum"],
      ["holiday_status_id"],
    ],
    { lazy: false },
  )) as Row[];
  const taken = (await exec(
    "hr.leave",
    "read_group",
    [
      [["state", "=", "validate"]],
      ["number_of_days:sum"],
      ["holiday_status_id"],
    ],
    { lazy: false },
  )) as Row[];
  const allocByType = new Map<number, number>();
  for (const g of allocs) {
    const t = id(g.holiday_status_id);
    if (t != null) allocByType.set(t, Number(g.number_of_days) || 0);
  }
  const takenByType = new Map<number, number>();
  for (const g of taken) {
    const t = id(g.holiday_status_id);
    if (t != null) takenByType.set(t, Number(g.number_of_days) || 0);
  }
  const allTypeIds = new Set<number>([
    ...allocByType.keys(),
    ...takenByType.keys(),
  ]);
  const types = (await exec(
    "hr.leave.type",
    "search_read",
    [[["id", "in", [...allTypeIds]]]],
    { fields: ["id", "name"] },
  )) as Row[];
  const typeName = new Map<number, string>();
  for (const t of types) typeName.set(Number(t.id), String(t.name));
  const negativeBalances: Array<{ type: string; saldo: number }> = [];
  for (const t of allTypeIds) {
    const alloc = allocByType.get(t) ?? 0;
    const tk = takenByType.get(t) ?? 0;
    const saldo = alloc - tk;
    const tn = typeName.get(t) ?? `type ${t}`;
    console.log(
      `  ${tn.padEnd(28)} alloc ${alloc.toFixed(1).padStart(8)}  fruito ${tk.toFixed(1).padStart(8)}  saldo ${saldo.toFixed(1).padStart(8)}${saldo < 0 ? "  ⚠ NEGATIVO" : ""}`,
    );
    if (saldo < 0) negativeBalances.push({ type: tn, saldo });
  }

  // ============== ANOMALY SUMMARY (machine-parseable, last line) ==============
  const summary = {
    window: { from: ymd(winStart), to: todayStr, days },
    activeEmployees: emps.length,
    anomalies: {
      openPriorDayPunches: openPriorDay.map((a) => ({
        id: a.id,
        employee: name(a.employee_id),
        checkIn: a.check_in,
      })),
      zeroHourPunches: zeroHour.map((a) => ({
        id: a.id,
        employee: name(a.employee_id),
        checkIn: a.check_in,
        workedHours: a.worked_hours,
      })),
      missingWeekdayPunches: missing.map((m) => ({
        employee: m.emp,
        count: m.days.length,
        days: m.days,
      })),
      negativeBalances,
    },
    closureDaysExcluded: closureDays,
    nonClockingStaff: nonClockers,
    counts: {
      openPriorDay: openPriorDay.length,
      zeroHour: zeroHour.length,
      employeesWithMissingDays: missing.length,
      negativeBalances: negativeBalances.length,
    },
    kpi: {
      monteOreWindow: Number(monteOre.toFixed(1)),
      presentiOggi: presentIds.size,
    },
  };
  const totalAnomalies =
    summary.counts.openPriorDay +
    summary.counts.zeroHour +
    summary.counts.employeesWithMissingDays +
    summary.counts.negativeBalances;
  console.log(
    `\n=== ANOMALIE TOTALI (classi A+B+C+saldi): ${totalAnomalies} ===`,
  );
  console.log(JSON.stringify({ bab76_anomaly_summary: summary }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
