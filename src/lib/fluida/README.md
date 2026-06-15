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

| Fluida field | Odoo field               | Role                  |
| ------------ | ------------------------ | --------------------- |
| badge        | `hr.employee.barcode`    | **primary** match key |
| user email   | `hr.employee.work_email` | fallback match key    |

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

### Real Fluida API (used by `FluidaApiSource`)

Auth is the **`x-fluida-app-uuid: <key>`** header (NOT Bearer); the key both
authenticates and scopes the company. Routes carry the company id:

- Punches: `GET /api/v1/stampings/list/{company_id}?from_date=&to_date=` — each
  stamping already carries `badge_id`, `user_email`, `direction` (IN/OUT) and
  `server_clock_at` (absolute UTC), so no contracts lookup is needed.
- Leaves: `GET /api/v1/requests/list/{company_id}` — **requires the key to be
  granted the "requests" read scope** in Fluida. Until then it returns 401 and
  the pipeline syncs attendance only (leaves fetched best-effort, never fatal).

### Environment

| Var                                                                        | Purpose                                                  |
| -------------------------------------------------------------------------- | -------------------------------------------------------- |
| `ODOO_URL` / `ODOO_DB` / `ODOO_USERNAME` (or `ODOO_USER`) / `ODOO_API_KEY` | Odoo write target (same secrets as the rest of the app)  |
| `FLUIDA_API_KEY`                                                           | Fluida app UUID — sent as `x-fluida-app-uuid`            |
| `FLUIDA_COMPANY_ID`                                                        | Fluida company id (UUID) used in the `{company_id}` path |
| `FLUIDA_API_URL`                                                           | Override API base (default `https://api.fluida.io`)      |
| `FLUIDA_PUNCHES_CSV` / `FLUIDA_LEAVES_CSV`                                 | CSV-fallback file paths (when no API key)                |
| `FLUIDA_TZ`                                                                | Timezone of naive CSV timestamps (default `Europe/Rome`) |

### Scheduling

Run `run.ts` from cron / a scheduled job (e.g. nightly `15 2 * * *`, or every
15 min for near-real-time). Exit code is non-zero when any error is logged, so
the scheduler marks the run failed. Each log line is JSON for ingestion by the
HR agent (Chronos).

## Idempotency & data quality

- Attendance is keyed on `(employee_id, check_in)`; leaves on
  `(employee_id, holiday_status_id, date_from)`. Re-running over an overlapping
  window updates instead of duplicating.
- Double scans within 60s are collapsed; `unknown`-direction punches are paired
  by alternating in/out.
- **Forgotten check-outs (open intervals) are NOT written** — Odoo allows only
  one open attendance per employee, so an open historical record both blocks
  later attendances and records a shift with no end. They are reported in
  `report.incompleteForReview` for HR to correct, rather than fabricating a
  check-out. Unmatched badges and orphan check-outs are likewise surfaced, never
  silently dropped.

## Status (BAB-74)

- ✅ **Attendance live & verified** — pilot load written to `hr.attendance`
  (`worked_hours` correctly nets the calendar lunch break). Idempotent re-runs.
- ⏳ **Leaves → `hr.leave`** — blocked until the Fluida app-uuid key is granted
  the `requests` read scope (Fluida portal, board/CEO). Code path is wired and
  resilient; flips on automatically once the scope lands.
