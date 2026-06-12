# Live smoke test — validating the connector against a real Odoo 18

The E2E suite (`test/e2e.test.ts`) drives the real MCP server against a faithful
JSON-RPC **fake**. This document covers the complementary **live smoke**: the same
real MCP server driven against a **real, running Odoo 18** over real HTTP/JSON-RPC.

## What `smoke/live-smoke.mjs` does

It boots the compiled MCP server (`dist/`), connects a real MCP client over the
in-memory transport, and exercises the full happy path against a live instance:

1. `listTools` (MCP handshake) — asserts all 9 tools are exposed
2. **auth + read** — `odoo_search_read` on `res.partner`
3. **write** — `odoo_create` a partner
4. **write + read-back** — `odoo_write` then `odoo_read`
5. **search** — `odoo_search` on `sale.order`
6. `odoo_call_method` — `res.partner.name_search`
7. cleanup — `odoo_unlink` the test partner

Instance selection (priority order):

- If `ODOO_URL` + `ODOO_API_KEY` are set, it uses that instance (point it at any
  real Odoo: an Odoo.sh branch, a customer sandbox, a local server).
- Otherwise it auto-provisions Odoo's free no-signup demo at `demo.odoo.com`.

```bash
npm run build
ODOO_URL=https://my.odoo.com ODOO_DB=mydb ODOO_USERNAME=admin ODOO_API_KEY=… \
  node smoke/live-smoke.mjs
```

## Validation performed for BAB-8 (2026-06-12)

Result: **PASS** against a genuine **Odoo 18.0** server (`server_version: 18.0`),
authenticating with a real 40-char API key minted via `res.users.apikeys`.
All seven steps above succeeded over real JSON-RPC. Transcript is attached to
[BAB-8](/BAB/issues/BAB-8).

### Where the Odoo 18 came from (and what did NOT work)

Free hosted Odoo 18 with a usable external API turned out to be unavailable:

| Path | Outcome |
| --- | --- |
| `demo.odoo.com` (Odoo Online SaaS) | Serves **saas~19.3**, not 18, **and** disables the external API (`/jsonrpc`, `/xmlrpc/2/*` → 404). Dead end. |
| `runbot.odoo.com` 18.0 builds | Genuine Odoo **18.0** with `/jsonrpc` present, but the external API is **IP-gated**: `"Access denied from your location — use a development database"`. Dead end for off-network clients. |
| Odoo.sh / Odoo Online **trial** pinned to 18 | Would expose the API, but requires account + email/GitHub signup (human verification). Not agent-executable. |
| Docker (`docker-compose.yml`) | No Docker runtime available on the runner. |

So the validation used a **self-hosted Odoo 18 from source on the runner**, at
zero cost and with no human in the loop:

1. `uv` to fetch a standalone **Python 3.12** (host Python is 3.9; Odoo 18 needs ≥3.10).
2. Standalone **PostgreSQL 18** binaries (host PG is 9.4; Odoo 18 needs ≥12),
   `initdb` into a throwaway cluster on port 5433 (trust auth, no admin needed).
3. `git clone --depth 1 --branch 18.0 https://github.com/odoo/odoo`.
4. `uv pip install -r requirements.txt`, substituting `psycopg2-binary` for
   `psycopg2` (no libpq dev headers on the runner) and dropping `python-ldap`
   (needs openldap headers; not exercised by the smoke).
5. `odoo-bin -d odoo_smoke -i base,sale --stop-after-init` to build the DB.
6. Start the HTTP server, mint an API key via `odoo-bin shell`, run the smoke.

The `smoke/setup-local-odoo18.sh` script captures these steps for reproduction.

### Takeaway for production

The connector talks to Odoo's external JSON-RPC API (`/jsonrpc`). This is enabled
on **self-managed Odoo** (on-prem, Odoo.sh) but **disabled on Odoo Online (SaaS)**.
Customers on Odoo Online cannot be integrated via this transport — they would
need the session-based web API instead. Worth surfacing during sales/onboarding.
