/**
 * Live smoke test: drives the *real* compiled MCP server (dist/) through a real
 * MCP client over the in-memory transport, against a *real running Odoo*.
 *
 * It does NOT use the JSON-RPC fake. Every tool call below hits a live Odoo
 * server over HTTP/JSON-RPC, exactly as a production AI agent would.
 *
 * Instance source (in priority order):
 *   1. Env vars ODOO_URL / ODOO_DB / ODOO_USERNAME / ODOO_API_KEY (use a real
 *      pinned instance, e.g. an Odoo 18 trial, when one is available).
 *   2. Otherwise: auto-provision Odoo's free, no-signup demo at demo.odoo.com
 *      (whatever current SaaS serie it serves) so the smoke is self-contained.
 *
 * Usage:  node smoke/live-smoke.mjs
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../dist/server.js";

const log = (...a) => console.log(...a);
const section = (t) => log(`\n=== ${t} ===`);

/** Resolve a live Odoo instance: explicit env, else provision a free demo. */
async function resolveInstance() {
  if (process.env.ODOO_URL && process.env.ODOO_API_KEY) {
    log("Using Odoo instance from environment variables.");
    return {
      url: process.env.ODOO_URL.replace(/\/+$/, ""),
      db: process.env.ODOO_DB,
      username: process.env.ODOO_USERNAME ?? "admin",
      apiKey: process.env.ODOO_API_KEY,
      source: "env",
    };
  }
  log("No ODOO_URL in env — provisioning a free demo.odoo.com instance...");
  const res = await fetch("https://demo.odoo.com/", { redirect: "follow" });
  // Final URL looks like:
  //   https://demoN.odoo.com/saas_worker/demo/login?dbname=...&user=admin&key=admin&redirect=
  const finalUrl = new URL(res.url);
  const host = `${finalUrl.protocol}//${finalUrl.host}`;
  const db = finalUrl.searchParams.get("dbname");
  const user = finalUrl.searchParams.get("user") ?? "admin";
  const key = finalUrl.searchParams.get("key") ?? "admin";
  if (!db) throw new Error(`Could not parse demo db from redirect: ${res.url}`);
  return {
    url: host,
    db,
    username: user,
    apiKey: key,
    source: "demo.odoo.com",
  };
}

/** Query server version straight from Odoo (out-of-band, for the transcript). */
async function serverVersion(url) {
  const r = await fetch(`${url}/web/webclient/version_info`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: {} }),
  });
  const j = await r.json();
  return j?.result?.server_version ?? "unknown";
}

async function callTool(client, name, args) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? "";
  if (res.isError) throw new Error(`tool ${name} errored: ${text}`);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return parsed;
}

async function main() {
  const inst = await resolveInstance();
  const version = await serverVersion(inst.url);

  section("LIVE TARGET");
  log(`source        : ${inst.source}`);
  log(`url           : ${inst.url}`);
  log(`db            : ${inst.db}`);
  log(`username      : ${inst.username}`);
  log(`server_version: ${version}`);

  // Point the real MCP server at the live instance via its real config loader.
  const config = {
    url: inst.url,
    db: inst.db,
    username: inst.username,
    apiKey: inst.apiKey,
    timeoutMs: 60_000,
    maxLimit: 1000,
    readonly: false,
  };

  const server = buildServer(config);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "live-smoke", version: "1.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  let created = null;
  try {
    section("1. listTools (MCP handshake)");
    const { tools } = await client.listTools();
    log(
      `tools exposed : ${tools
        .map((t) => t.name)
        .sort()
        .join(", ")}`,
    );

    section("2. AUTH + READ — search_read res.partner (companies)");
    const partners = await callTool(client, "odoo_search_read", {
      model: "res.partner",
      domain: [["is_company", "=", true]],
      fields: ["id", "name", "email", "country_id"],
      limit: 3,
    });
    log(`companies read: ${partners.length}`);
    log(JSON.stringify(partners, null, 2));

    section("3. WRITE — create res.partner");
    const createRes = await callTool(client, "odoo_create", {
      model: "res.partner",
      values: {
        name: "Baboo Smoke Test (BAB-8)",
        is_company: true,
        email: "smoke@baboo.eu",
        comment: "Created by Baboo mcp-odoo live smoke test — safe to delete.",
      },
    });
    created = createRes.id;
    log(`created id    : ${created}`);

    section("4. WRITE — update + re-read the new partner");
    const wrote = await callTool(client, "odoo_write", {
      model: "res.partner",
      ids: [created],
      values: { phone: "+39 000 000", email: "smoke+updated@baboo.eu" },
    });
    log(`write success : ${wrote.success}`);
    const reread = await callTool(client, "odoo_read", {
      model: "res.partner",
      ids: [created],
      fields: ["name", "email", "phone"],
    });
    log(JSON.stringify(reread, null, 2));

    section("5. SEARCH — sale.order ids");
    try {
      const soIds = await callTool(client, "odoo_search", {
        model: "sale.order",
        domain: [],
        limit: 5,
      });
      log(`sale.order ids: ${JSON.stringify(soIds)} (${soIds.length} found)`);
    } catch (e) {
      log(`sale.order search note: ${e.message}`);
      log(
        "(Sales app may not be installed on this demo — model reachable check:)",
      );
      const models = await callTool(client, "odoo_list_models", {
        filter: "sale.order",
      });
      log(`ir.model lookup: ${JSON.stringify(models)}`);
    }

    section("6. call_method — res.partner.name_search('Baboo')");
    const ns = await callTool(client, "odoo_call_method", {
      model: "res.partner",
      method: "name_search",
      kwargs: { name: "Baboo" },
    });
    log(JSON.stringify(ns, null, 2));
  } finally {
    if (created != null) {
      section("CLEANUP — unlink the test partner");
      try {
        const del = await callTool(client, "odoo_unlink", {
          model: "res.partner",
          ids: [created],
        });
        log(`unlink success: ${del.success}`);
      } catch (e) {
        log(`cleanup note  : ${e.message}`);
      }
    }
    await client.close();
  }

  section("RESULT");
  log("PASS — real MCP server drove live Odoo over JSON-RPC end-to-end.");
}

main().catch((e) => {
  console.error("\n=== RESULT ===");
  console.error(`FAIL — ${e.stack ?? e.message ?? e}`);
  process.exit(1);
});
