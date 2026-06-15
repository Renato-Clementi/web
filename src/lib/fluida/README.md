# Fluida → Odoo 18 HR sync (BAB-74)

Pipeline that imports **timbrature** (clock-in/out) into Odoo `hr.attendance` and
**approved leaves** (ferie / permessi) into `hr.leave`, on a schedule, with
structured logging for the HR agent (Chronos).

It is built against two interfaces so the whole flow is testable offline with no
credentials:

- `FluidaSource` — where punches/leaves come from
- `OdooHrPort` — where they are written

```
source.fetch ──▶ mapping (badge/email → employee)
                    │
        ┌───────────┴────────────┐
   attendance.ts             leave.ts
 (pair in/out, dedup)   (label → hr.leave.type)
        │                        │
        └──────── pipeline.runSync ───────▶ Odoo (idempotent upsert) + SyncReport
```

## Mapping (from BAB-73)

| Fluida field | Odoo field             | Role                      |
| ------------ | ---------------------- | ------------------------- |
| badge        | `hr.employee.barcode`  | **primary** match key     |
| user email   | `hr.employee.work_email` | fallback match key      |

Leave-type labels map to the `hr.leave.type` ids configured in BAB-73
(1 Ferie · 2 Malattia · 3 Recupero/Banca Ore · 4 Permesso non retribuito ·
5 Permessi ROL/Ex-festività). Unknown labels are **reported, never guessed**.

## Sources

1. **Live REST API** (`FluidaApiSource`) — preferred. Needs `FLUIDA_API_KEY`
   (board-provided secret). Field-name normalizers are lenient so the exact
   portal payload is adapted with config, not a rewrite.
2. **CSV / Excel export** (`FluidaCsvSource`) — documented fallback, usable today
   with **no credentials**. Parses a Zucchetti/Excel-as-CSV export; naive
   wall-clock times are interpreted in `Europe/Rome` (DST-correct) and converted
   to UTC for Odoo. See `fixtures/` for the expected columns.

## Running (schedulable)

```bash
# last 24h, live write
tsx src/lib/fluida/run.ts

# compute only — no writes (use before the first live cutover)
tsx src/lib/fluida/run.ts --dry-run

# custom lookback
tsx src/lib/fluida/run.ts --since-hours=48
```

Source selection is automatic: if `FLUIDA_API_KEY` is set it uses the API,
otherwise it reads `FLUIDA_PUNCHES_CSV` (and optional `FLUIDA_LEAVES_CSV`).

### Environment

| Var | Purpose |
| --- | ------- |
| `ODOO_URL` / `ODOO_DB` / `ODOO_USERNAME` / `ODOO_API_KEY` | Odoo write target (same secrets as the rest of the app) |
| `FLUIDA_API_KEY` | Fluida Developer Portal key — **board secret, pending** |
| `FLUIDA_API_URL` | Override API base (default `https://api.fluida.io`) |
| `FLUIDA_PUNCHES_CSV` / `FLUIDA_LEAVES_CSV` | CSV-fallback file paths |
| `FLUIDA_TZ` | Timezone of naive export timestamps (default `Europe/Rome`) |

### Scheduling

Run `run.ts` from cron / a scheduled job (e.g. nightly `15 2 * * *`, or every
15 min for near-real-time). Exit code is non-zero when any error is logged, so
the scheduler marks the run failed. Each log line is JSON for ingestion by the
HR agent.

## Idempotency & data quality

- Attendance is keyed on `(employee_id, check_in)`; leaves on
  `(employee_id, holiday_status_id, date_from)`. Re-running over an overlapping
  window updates instead of duplicating.
- Double scans within 60s are collapsed; `unknown`-direction punches are paired
  by alternating in/out.
- Forgotten check-outs, orphan check-outs, and unmatched badges are surfaced as
  warnings in the report — never silently dropped.

## Live cutover prerequisites (tracked on BAB-74)

1. **`hr_attendance` module must be installed** on the Odoo instance — it is
   currently uninstalled (BAB-73). `hr.leave` is already available.
2. **`FLUIDA_API_KEY`** provisioned (or a CSV export supplied) — board secret.
3. **Employee `barcode` populated** with real Fluida badge ids.

Until 1–3 land, run with `--dry-run` against a CSV sample to validate mapping
and pairing.
