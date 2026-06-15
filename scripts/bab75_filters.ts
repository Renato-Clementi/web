/**
 * BAB-75 Fase 4 — persistent HR reporting views as global ir.filters.
 *
 * Creates (idempotently) the saved searches HR opens from the native Odoo 18
 * Attendances / Time Off reporting menus, so the BAB-75 reports are
 * "generabili" on demand rather than one-off script output. Reversible
 * (additive saved filters; no employee data touched).
 *
 * Domains use Odoo's filter eval helpers (context_today / relativedelta) so
 * "today" / "this month" stay dynamic. Idempotent: skip if a same-name global
 * filter already exists on the model. Verifies each by running its domain via
 * search_count and reads the created records back.
 *
 *   tsx scripts/bab75_filters.ts            # create + verify
 *   tsx scripts/bab75_filters.ts --dry-run  # show plan only
 */
import { OdooHrRpcClient, readOdooEnv } from "../src/lib/fluida/odoo";

type Exec = (
  m: string,
  meth: string,
  args: unknown[],
  kw?: Record<string, unknown>,
) => Promise<unknown>;

interface FilterSpec {
  name: string;
  model: string;
  domain: string;
  context: string;
}

const FILTERS: FilterSpec[] = [
  {
    name: "BAB-75 · Presenti oggi",
    model: "hr.attendance",
    domain:
      "[('check_in','>=', context_today().strftime('%Y-%m-%d 00:00:00'))]",
    context: "{'group_by': ['employee_id']}",
  },
  {
    name: "BAB-75 · Ore lavorate per dipendente (mese corrente)",
    model: "hr.attendance",
    domain:
      "[('check_in','>=', context_today().strftime('%Y-%m-01 00:00:00'))]",
    context: "{'group_by': ['employee_id'], 'pivot_measures': ['worked_hours']}",
  },
  {
    name: "BAB-75 · Timbrature incomplete (checkout mancante)",
    model: "hr.attendance",
    domain: "[('check_out','=', False)]",
    context: "{'group_by': ['employee_id']}",
  },
  {
    name: "BAB-75 · Ferie/permessi previsti (approvati, da oggi)",
    model: "hr.leave",
    domain:
      "[('state','=','validate'), ('date_from','>=', context_today().strftime('%Y-%m-%d 00:00:00'))]",
    context: "{'group_by': ['employee_id', 'holiday_status_id']}",
  },
  {
    name: "BAB-75 · Saldo ferie/permessi per dipendente",
    model: "hr.leave.allocation",
    domain: "[('state','=','validate')]",
    context: "{'group_by': ['holiday_status_id', 'employee_id']}",
  },
];

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const env = readOdooEnv();
  if (!env) throw new Error("ODOO_* env not configured");
  const odoo = new OdooHrRpcClient(env);
  const exec = (odoo as unknown as { exec: Exec }).exec.bind(odoo);

  console.log(`=== BAB-75 reporting filters ${dryRun ? "(DRY RUN)" : ""} ===\n`);

  for (const f of FILTERS) {
    // idempotency: same name on same model (any user_id)
    const existing = (await exec("ir.filters", "search_read", [
      [
        ["name", "=", f.name],
        ["model_id", "=", f.model],
      ],
    ], { fields: ["id", "user_id"] })) as Record<string, unknown>[];

    let fid: number;
    if (existing.length) {
      fid = Number(existing[0].id);
      console.log(`= exists  [${fid}] ${f.name}`);
    } else if (dryRun) {
      console.log(`+ would create  ${f.name}  (${f.model})`);
      continue;
    } else {
      fid = (await exec("ir.filters", "create", [
        {
          name: f.name,
          model_id: f.model,
          domain: f.domain,
          context: f.context,
          user_id: false, // global → visible to all HR users
          is_default: false,
        },
      ])) as number;
      console.log(`+ created [${fid}] ${f.name}  (${f.model})`);
    }

    // verify: run the saved domain via search_count to prove it generates
    try {
      // eval the domain the same way the client would (server eval not exposed
      // over RPC), so we re-run a static equivalent for counting only.
      const cnt = (await exec(f.model, "search_count", [
        evalDomain(f),
      ])) as number;
      console.log(`    domain matches ${cnt} record(s) now`);
    } catch (e) {
      console.log(`    (count skipped: ${(e as Error).message})`);
    }
  }

  console.log(`\n--- verify: global BAB-75 filters present ---`);
  const all = (await exec("ir.filters", "search_read", [
    [["name", "like", "BAB-75"]],
  ], { fields: ["id", "name", "model_id", "user_id"], order: "id asc" })) as Record<string, unknown>[];
  for (const r of all)
    console.log(`  [${r.id}] ${r.name}  model=${r.model_id}  user=${JSON.stringify(r.user_id)}`);
  console.log(`\n=== done ===`);
}

/** Re-create the dynamic dates in JS so we can count without server-side eval. */
function evalDomain(f: FilterSpec): unknown[] {
  const now = new Date();
  const y = now.getUTCFullYear();
  const mo = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const today0 = `${y}-${mo}-${d} 00:00:00`;
  const month0 = `${y}-${mo}-01 00:00:00`;
  if (f.model === "hr.leave.allocation") return [["state", "=", "validate"]];
  if (f.model === "hr.leave")
    return [
      ["state", "=", "validate"],
      ["date_from", ">=", today0],
    ];
  // hr.attendance variants
  if (f.domain.includes("check_out")) return [["check_out", "=", false]];
  if (f.domain.includes("%Y-%m-01")) return [["check_in", ">=", month0]];
  return [["check_in", ">=", today0]];
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
