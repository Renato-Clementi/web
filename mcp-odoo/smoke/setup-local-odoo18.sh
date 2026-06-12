#!/usr/bin/env bash
#
# Provision a throwaway Odoo 18 from source on a machine with NO Docker and NO
# admin rights, then run the connector's live smoke against it.
#
# Used to validate BAB-8 when no hosted Odoo 18 with an open external API was
# available (Odoo Online SaaS disables /jsonrpc; runbot IP-gates it; trials need
# human signup). Requires: a C compiler (Xcode CLT / build-essential), git,
# curl, and outbound network. Everything else is downloaded into $WORK.
#
# Not wired into CI — it downloads ~1.2 GB of Odoo source + a Python + Postgres.
# Run it by hand when you want a real-Odoo validation and have no live instance.
set -euo pipefail

WORK="${WORK:-/tmp/odoo18-smoke}"
PORT_PG="${PORT_PG:-5433}"
PORT_HTTP="${PORT_HTTP:-8069}"
WHO="$(whoami)"
HERE="$(cd "$(dirname "$0")" && pwd)"          # mcp-odoo/smoke
MCP_DIR="$(dirname "$HERE")"                     # mcp-odoo
mkdir -p "$WORK"; cd "$WORK"

echo "==> 1. uv + standalone Python 3.12"
command -v uv >/dev/null || curl -LsSf https://astral.sh/uv/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
uv python install 3.12
[ -d .venv ] || uv venv --python 3.12 .venv

echo "==> 2. standalone PostgreSQL (>=12) binaries"
if [ ! -x pgdist/bin/postgres ]; then
  BASE=https://repo1.maven.org/maven2/io/zonky/test/postgres/embedded-postgres-binaries-darwin-amd64
  VER=$(curl -sS "$BASE/maven-metadata.xml" | grep -oE '<release>[^<]+' | sed 's/<release>//')
  curl -sS -o pg.jar "$BASE/$VER/embedded-postgres-binaries-darwin-amd64-$VER.jar"
  mkdir -p pgdist && (cd pgdist && unzip -o ../pg.jar >/dev/null && tar xf ./*.txz)
fi
PGBIN="$WORK/pgdist/bin"
export PGDATA="$WORK/pg18data"
if [ ! -d "$PGDATA" ]; then
  "$PGBIN/initdb" -D "$PGDATA" -U "$WHO" --auth=trust --encoding=UTF8
fi
mkdir -p "$WORK/pgsock"
"$PGBIN/pg_ctl" -D "$PGDATA" \
  -o "-p $PORT_PG -k $WORK/pgsock -c listen_addresses='localhost'" \
  -l "$WORK/pg18.log" start || true

echo "==> 3. Odoo 18.0 source"
[ -d odoo-src ] || git clone --depth 1 --branch 18.0 https://github.com/odoo/odoo.git odoo-src

echo "==> 4. Python deps (psycopg2-binary instead of psycopg2; drop python-ldap)"
grep -viE '^\s*(psycopg2|python-ldap)\b' odoo-src/requirements.txt > req.filtered.txt
echo "psycopg2-binary>=2.9.9" >> req.filtered.txt
uv pip install --python .venv -r req.filtered.txt

DB_ARGS="--db_host localhost --db_port $PORT_PG --db_user $WHO --data-dir $WORK/odoo-data"

echo "==> 5. init DB (base + sale)"
PYTHONPATH=odoo-src .venv/bin/python odoo-src/odoo-bin \
  -d odoo_smoke -i base,sale $DB_ARGS --stop-after-init --log-level=warn

echo "==> 6. mint API key + start server"
KEY=$(PYTHONPATH=odoo-src .venv/bin/python odoo-src/odoo-bin shell -d odoo_smoke $DB_ARGS \
  --log-level=error --no-http 2>/dev/null <<'PY' | grep -oE 'APIKEY=.*' | sed 's/APIKEY=//'
admin = env['res.users'].search([('login','=','admin')], limit=1)
print("APIKEY=%s" % env['res.users.apikeys'].with_user(admin)._generate('rpc','smoke',False))
env.cr.commit()
PY
)
PYTHONPATH=odoo-src .venv/bin/python odoo-src/odoo-bin \
  -d odoo_smoke $DB_ARGS --http-port="$PORT_HTTP" --log-level=error \
  > "$WORK/odoo-server.log" 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null; "$PGBIN/pg_ctl" -D "$PGDATA" stop >/dev/null 2>&1 || true' EXIT
for i in $(seq 1 60); do
  curl -s -o /dev/null --max-time 4 "http://localhost:$PORT_HTTP/web/webclient/version_info" \
    -X POST -H 'Content-Type: application/json' -d '{}' && break
  sleep 1
done

echo "==> 7. run live smoke"
( cd "$MCP_DIR" && npm run build >/dev/null 2>&1 || true
  ODOO_URL="http://localhost:$PORT_HTTP" ODOO_DB=odoo_smoke ODOO_USERNAME=admin ODOO_API_KEY="$KEY" \
    node smoke/live-smoke.mjs )
