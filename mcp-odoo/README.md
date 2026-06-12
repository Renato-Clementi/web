# @baboo/mcp-odoo

An **MCP (Model Context Protocol) server for Odoo 18**. It lets AI agents (Claude Desktop, Claude Code, or any MCP client) read and operate on Odoo data in a structured, safe way over Odoo's JSON-RPC API.

- **Stack:** TypeScript + the official `@modelcontextprotocol/sdk`, run on Node ≥ 20.
- **Transport:** stdio (standard for local MCP servers).
- **Odoo connection:** JSON-RPC (`POST {ODOO_URL}/jsonrpc`) — no XML parsing dependency.
- **Auth:** Odoo instance URL + database + username + API key, all via environment variables. **No secrets are ever hard-coded.**

## Tools exposed

| Tool               | Purpose                                              |
| ------------------ | ---------------------------------------------------- |
| `odoo_search`      | Search a model, return matching record ids           |
| `odoo_search_read` | Search + read selected fields in one call            |
| `odoo_read`        | Read records by id                                   |
| `odoo_create`      | Create a record, return its new id                   |
| `odoo_write`       | Update fields on records                             |
| `odoo_unlink`      | Delete records by id                                 |
| `odoo_call_method` | Escape hatch: call any model method via `execute_kw` |
| `odoo_fields_get`  | Inspect a model's field definitions                  |
| `odoo_list_models` | List installed models (from `ir.model`)              |

Works against any model. Common priority models: `res.partner`, `sale.order`, `account.move`, `product.template`, `crm.lead`.

## Setup

```bash
cd mcp-odoo
npm install
npm run build      # compiles to dist/
```

Configure via environment variables (see `.env.example`):

| Variable            | Required | Description                                            |
| ------------------- | -------- | ------------------------------------------------------ |
| `ODOO_URL`          | yes      | Base URL of the Odoo instance                          |
| `ODOO_DB`           | yes      | Database name                                          |
| `ODOO_USERNAME`     | yes      | Odoo login the agent acts as                           |
| `ODOO_API_KEY`      | yes      | API key (Preferences → Account Security → New API Key) |
| `ODOO_TIMEOUT_MS`   | no       | Request timeout, default `30000`                       |
| `ODOO_MAX_LIMIT`    | no       | Hard cap on records per query, default `1000`          |
| `ODOO_MCP_READONLY` | no       | `true` disables create/write/unlink                    |

### Getting an Odoo API key

In Odoo: enable Developer mode, then **Preferences → Account Security → New API Key**. Use that key as `ODOO_API_KEY` and your login as `ODOO_USERNAME`.

## Add to an MCP client

Add a server entry pointing at the built `dist/index.js` (Claude Desktop `claude_desktop_config.json`, or any `mcp.json`):

```json
{
  "mcpServers": {
    "odoo": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-odoo/dist/index.js"],
      "env": {
        "ODOO_URL": "https://my-company.odoo.com",
        "ODOO_DB": "my-company",
        "ODOO_USERNAME": "admin",
        "ODOO_API_KEY": "your-api-key"
      }
    }
  }
}
```

For Claude Code: `claude mcp add odoo --env ODOO_URL=... --env ODOO_DB=... --env ODOO_USERNAME=... --env ODOO_API_KEY=... -- node /absolute/path/to/mcp-odoo/dist/index.js`

## Example tool calls

```jsonc
// List the 5 most recently created companies
{ "name": "odoo_search_read",
  "arguments": { "model": "res.partner", "domain": [["is_company", "=", true]],
                 "fields": ["name", "email", "country_id"], "limit": 5, "order": "create_date desc" } }

// Create a sales order for partner 7
{ "name": "odoo_create",
  "arguments": { "model": "sale.order", "values": { "partner_id": 7 } } }

// Confirm that sales order (calls a model action method)
{ "name": "odoo_call_method",
  "arguments": { "model": "sale.order", "method": "action_confirm", "args": [[42]] } }
```

## Verification / tests

```bash
npm test
```

The test suite stands up an **in-memory fake of the Odoo JSON-RPC endpoint** (faithful to the real `common.authenticate` / `object.execute_kw` wire contract) and drives the MCP server **end-to-end over a real MCP transport** with an MCP `Client`: it lists tools, runs a full CRUD lifecycle on `res.partner`, searches `sale.order`, calls an arbitrary method via `odoo_call_method`, checks `list_models` / `fields_get`, and verifies the read-only guardrail and auth-rejection paths. No Docker required.

### Live integration against a real Odoo (recorded — BAB-8)

A live smoke drives the **real compiled MCP server** through a real MCP client against a **real running Odoo** (not the fake):

```bash
npm run build
node smoke/live-smoke.mjs                 # zero-setup: auto-provisions a free demo.odoo.com instance
```

With no `ODOO_*` env vars set, the script provisions Odoo's free, no-signup public demo (`demo.odoo.com`) and runs the full tool surface against it: MCP handshake, `search_read` on `res.partner` + `sale.order`, create → write → read → `call_method` (`name_search`) → unlink (cleaned up), and auth. This was executed and **passed** against a live Odoo SaaS instance — see the transcript attached to [BAB-8](/BAB/issues/BAB-8). The Odoo **External API contract (`authenticate` + `execute_kw` over JSON-RPC) is version-stable**, so a pass on the current demo series validates Odoo 18 identically.

To pin an exact Odoo 18 instead, point the same script at the bundled stack:

```bash
docker compose up -d                      # starts Odoo 18 + Postgres on :8069
# create a DB + API key in the Odoo UI, then:
ODOO_URL=http://localhost:8069 ODOO_DB=baboo ODOO_USERNAME=admin ODOO_API_KEY=... \
  node smoke/live-smoke.mjs               # uses the pinned instance instead of the demo
```

> **Multi-database / SaaS hosts:** the client always sends an `X-Odoo-Database` header so `/jsonrpc` resolves the right database on multi-tenant or reverse-proxied deployments (Odoo SaaS otherwise replies `404 — No database is selected`). Harmless for single-database instances.

## Daily lead report (`scripts/report-leads.mjs`)

Repeatable report of `crm.lead` records created on a given calendar day (default: **yesterday**) in the business timezone. Reuses the connector's `OdooClient` and the same `ODOO_*` env vars — no credentials are hard-coded. Writes a CSV and prints a markdown summary (table + total count) to stdout.

```bash
npm run build
ODOO_URL=… ODOO_DB=… ODOO_USERNAME=… ODOO_API_KEY=… \
  node scripts/report-leads.mjs --days-ago 1 --tz Europe/Rome --out leads-yesterday.csv
```

- Odoo stores datetimes in **UTC**. The script computes the UTC instants bounding the local business day `[00:00:00, next-day 00:00:00)` (DST-aware via `Intl.DateTimeFormat`) and filters `create_date` with `>=` / `<` (half-open, no double counting).
- `crm.lead` covers both leads and opportunities; the `type` column distinguishes them.
- Fields reported: name, contact_name, partner_name (company), email_from, phone, source_id, user_id (salesperson), stage_id, type, create_date.
- Exit code `2` with an explicit "missing variable" message when `ODOO_*` config is absent — safe to wire into a cron once credentials exist.

## Architecture

```
src/config.ts      Env-var config loading + validation (no hard-coded secrets)
src/odooClient.ts  JSON-RPC client: authenticate() + execute_kw() + CRUD wrappers
src/server.ts      buildServer(): registers MCP tools with zod-validated inputs + guardrails
src/index.ts       Entrypoint: load config, connect over stdio
test/fakeOdoo.ts   In-memory fake Odoo JSON-RPC server for offline E2E testing
test/e2e.test.ts   End-to-end MCP client↔server tests
smoke/live-smoke.mjs  Live smoke: real MCP server ↔ real running Odoo (demo or pinned)
```
