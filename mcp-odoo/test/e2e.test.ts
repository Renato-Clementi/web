import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig, type OdooConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";
import { OdooClient } from "../src/odooClient.js";
import { startFakeOdoo, FAKE_CREDENTIALS, type FakeOdoo } from "./fakeOdoo.js";

let fake: FakeOdoo;
let client: Client;

function configFor(
  url: string,
  extra: Record<string, string> = {},
): OdooConfig {
  return loadConfig({
    ODOO_URL: url,
    ODOO_DB: FAKE_CREDENTIALS.db,
    ODOO_USERNAME: FAKE_CREDENTIALS.login,
    ODOO_API_KEY: FAKE_CREDENTIALS.apiKey,
    ...extra,
  } as NodeJS.ProcessEnv);
}

/** Helper: call a tool and parse the single text-content JSON payload. */
async function callJson(
  name: string,
  args: Record<string, unknown>,
): Promise<any> {
  const res: any = await client.callTool({ name, arguments: args });
  expect(
    res.isError ?? false,
    `tool ${name} returned error: ${res.content?.[0]?.text}`,
  ).toBe(false);
  return JSON.parse(res.content[0].text);
}

beforeAll(async () => {
  fake = await startFakeOdoo();
  const server = buildServer(configFor(fake.url));
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
});

afterAll(async () => {
  await client?.close();
  await fake?.close();
});

describe("Odoo MCP server (end-to-end over MCP transport against a fake Odoo JSON-RPC)", () => {
  it("exposes the full set of core tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "odoo_call_method",
        "odoo_create",
        "odoo_fields_get",
        "odoo_list_models",
        "odoo_read",
        "odoo_search",
        "odoo_search_read",
        "odoo_unlink",
        "odoo_write",
      ].sort(),
    );
  });

  it("search_read returns res.partner companies", async () => {
    const partners = await callJson("odoo_search_read", {
      model: "res.partner",
      domain: [["is_company", "=", true]],
      fields: ["name", "email"],
    });
    expect(partners).toHaveLength(1);
    expect(partners[0]).toMatchObject({
      name: "Acme Corp",
      email: "info@acme.test",
    });
  });

  it("full CRUD lifecycle on res.partner", async () => {
    const { id } = await callJson("odoo_create", {
      model: "res.partner",
      values: { name: "Beta Ltd", is_company: true, email: "hi@beta.test" },
    });
    expect(typeof id).toBe("number");

    const read = await callJson("odoo_read", {
      model: "res.partner",
      ids: [id],
      fields: ["name", "email"],
    });
    expect(read[0]).toMatchObject({ name: "Beta Ltd", email: "hi@beta.test" });

    const written = await callJson("odoo_write", {
      model: "res.partner",
      ids: [id],
      values: { email: "sales@beta.test" },
    });
    expect(written.success).toBe(true);

    const reread = await callJson("odoo_read", {
      model: "res.partner",
      ids: [id],
      fields: ["email"],
    });
    expect(reread[0].email).toBe("sales@beta.test");

    const unlinked = await callJson("odoo_unlink", {
      model: "res.partner",
      ids: [id],
    });
    expect(unlinked.success).toBe(true);

    const gone = await callJson("odoo_read", {
      model: "res.partner",
      ids: [id],
    });
    expect(gone).toHaveLength(0);
  });

  it("search returns sale.order ids", async () => {
    const ids = await callJson("odoo_search", {
      model: "sale.order",
      domain: [["state", "=", "draft"]],
    });
    expect(ids).toContain(10);
  });

  it("call_method invokes an arbitrary model method (name_search)", async () => {
    const results = await callJson("odoo_call_method", {
      model: "res.partner",
      method: "name_search",
      kwargs: { name: "acme" },
    });
    expect(results).toEqual([[1, "Acme Corp"]]);
  });

  it("list_models filters via ir.model", async () => {
    const models = await callJson("odoo_list_models", { filter: "sale" });
    expect(models.map((m: any) => m.model)).toContain("sale.order");
  });

  it("fields_get returns field metadata", async () => {
    const fields = await callJson("odoo_fields_get", { model: "res.partner" });
    expect(fields.name).toMatchObject({ type: "char" });
  });
});

describe("guardrails", () => {
  it("read-only mode blocks writes", async () => {
    const server = buildServer(
      configFor(fake.url, { ODOO_MCP_READONLY: "true" }),
    );
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const roClient = new Client({ name: "ro", version: "1.0.0" });
    await Promise.all([server.connect(st), roClient.connect(ct)]);
    const res: any = await roClient.callTool({
      name: "odoo_create",
      arguments: { model: "res.partner", values: { name: "Nope" } },
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/read-only/i);
    await roClient.close();
  });

  it("rejects bad credentials", async () => {
    const badConfig = configFor(fake.url, { ODOO_API_KEY: "wrong" });
    const odoo = new OdooClient(badConfig);
    await expect(odoo.authenticate()).rejects.toThrow(/Authentication failed/);
  });
});
