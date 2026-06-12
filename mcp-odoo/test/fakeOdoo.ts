import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";

/**
 * A minimal in-memory fake of the Odoo 18 JSON-RPC endpoint, faithful to the
 * wire contract the real client speaks (`common.authenticate`, `object.execute_kw`).
 * Used to exercise the MCP server end-to-end without Docker.
 */
type Record_ = { id: number; [k: string]: unknown };

const CREDENTIALS = {
  db: "baboo",
  login: "admin",
  apiKey: "test-api-key",
  uid: 2,
};

export interface FakeOdoo {
  url: string;
  close: () => Promise<void>;
  store: Map<string, Record_[]>;
}

function matchDomain(rec: Record_, domain: unknown[]): boolean {
  for (const clause of domain) {
    if (!Array.isArray(clause)) continue; // ignore '&'/'|' operators in this fake
    const [field, op, value] = clause as [string, string, unknown];
    const actual = rec[field];
    switch (op) {
      case "=":
        if (actual !== value) return false;
        break;
      case "!=":
        if (actual === value) return false;
        break;
      case "ilike":
        if (
          !String(actual ?? "")
            .toLowerCase()
            .includes(String(value).toLowerCase())
        )
          return false;
        break;
      case "in":
        if (!Array.isArray(value) || !value.includes(actual)) return false;
        break;
      default:
        break;
    }
  }
  return true;
}

export async function startFakeOdoo(): Promise<FakeOdoo> {
  const store = new Map<string, Record_[]>();
  store.set("res.partner", [
    { id: 1, name: "Acme Corp", is_company: true, email: "info@acme.test" },
    { id: 2, name: "John Doe", is_company: false, email: "john@acme.test" },
  ]);
  store.set("sale.order", [
    { id: 10, name: "S00001", partner_id: 1, state: "draft", amount_total: 0 },
  ]);
  store.set("ir.model", [
    { id: 100, model: "res.partner", name: "Contact" },
    { id: 101, model: "sale.order", name: "Sales Order" },
  ]);
  let seq = 1000;

  const handleExecuteKw = (args: unknown[]): unknown => {
    const [, , , model, method, methodArgs = [], kwargs = {}] = args as [
      string,
      number,
      string,
      string,
      string,
      unknown[],
      Record<string, unknown>,
    ];
    const records =
      store.get(model) ?? (store.set(model, []), store.get(model)!);
    const kw = kwargs as {
      fields?: string[];
      limit?: number;
      offset?: number;
      order?: string;
    };

    const project = (rec: Record_): Record_ => {
      if (!kw.fields || kw.fields.length === 0) return { ...rec };
      const out: Record_ = { id: rec.id };
      for (const f of kw.fields) out[f] = rec[f];
      return out;
    };

    switch (method) {
      case "search": {
        const domain = (methodArgs[0] as unknown[]) ?? [];
        let matched = records.filter((r) => matchDomain(r, domain));
        if (kw.offset) matched = matched.slice(kw.offset);
        if (kw.limit) matched = matched.slice(0, kw.limit);
        return matched.map((r) => r.id);
      }
      case "search_read": {
        const domain = (methodArgs[0] as unknown[]) ?? [];
        let matched = records.filter((r) => matchDomain(r, domain));
        if (kw.offset) matched = matched.slice(kw.offset);
        if (kw.limit) matched = matched.slice(0, kw.limit);
        return matched.map(project);
      }
      case "read": {
        const ids = (methodArgs[0] as number[]) ?? [];
        return records.filter((r) => ids.includes(r.id)).map(project);
      }
      case "create": {
        const values = (methodArgs[0] as Record<string, unknown>) ?? {};
        const id = ++seq;
        records.push({ id, ...values });
        return id;
      }
      case "write": {
        const ids = (methodArgs[0] as number[]) ?? [];
        const values = (methodArgs[1] as Record<string, unknown>) ?? {};
        for (const r of records)
          if (ids.includes(r.id)) Object.assign(r, values);
        return true;
      }
      case "unlink": {
        const ids = (methodArgs[0] as number[]) ?? [];
        store.set(
          model,
          records.filter((r) => !ids.includes(r.id)),
        );
        return true;
      }
      case "fields_get":
        return {
          name: { string: "Name", type: "char", required: true },
          email: { string: "Email", type: "char", required: false },
        };
      case "name_search": {
        // Demonstrate odoo_call_method against a real-ish method.
        const name = (kw as unknown as { name?: string }).name ?? "";
        return records
          .filter((r) =>
            String(r.name ?? "")
              .toLowerCase()
              .includes(String(name).toLowerCase()),
          )
          .map((r) => [r.id, r.name]);
      }
      default:
        throw {
          code: 200,
          message: "Odoo Server Error",
          data: { message: `Unknown method ${method}` },
        };
    }
  };

  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let payload: {
        id?: number;
        params?: { service: string; method: string; args: unknown[] };
      };
      try {
        payload = JSON.parse(body);
      } catch {
        res.writeHead(400).end("bad json");
        return;
      }
      const { service, method, args } = payload.params!;
      const reply = (result?: unknown, error?: unknown) =>
        res.writeHead(200, { "Content-Type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: payload.id,
            ...(error ? { error } : { result }),
          }),
        );

      try {
        if (service === "common" && method === "authenticate") {
          const [db, login, apiKey] = args as [string, string, string];
          const ok =
            db === CREDENTIALS.db &&
            login === CREDENTIALS.login &&
            apiKey === CREDENTIALS.apiKey;
          reply(ok ? CREDENTIALS.uid : false);
          return;
        }
        if (service === "object" && method === "execute_kw") {
          reply(handleExecuteKw(args));
          return;
        }
        reply(undefined, {
          code: 404,
          message: `Unknown service ${service}.${method}`,
        });
      } catch (err) {
        reply(undefined, err);
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    store,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export const FAKE_CREDENTIALS = CREDENTIALS;
