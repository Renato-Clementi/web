import type { OdooConfig } from "./config.js";

/**
 * Minimal Odoo 18 JSON-RPC client.
 *
 * Odoo exposes a JSON-RPC endpoint at `POST {url}/jsonrpc`. We use two services:
 *  - `common.authenticate(db, login, password, {})` -> uid
 *  - `object.execute_kw(db, uid, password, model, method, args, kwargs)` -> result
 *
 * The Odoo API key is passed in the password position; Odoo >= 14 accepts it there.
 */
export class OdooError extends Error {
  constructor(
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "OdooError";
  }
}

interface JsonRpcResponse {
  jsonrpc: string;
  id: number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: { name?: string; message?: string; debug?: string };
  };
}

export class OdooClient {
  private uid: number | null = null;
  private nextId = 1;

  constructor(private readonly config: OdooConfig) {}

  private async rpc(
    service: string,
    method: string,
    args: unknown[],
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${this.config.url}/jsonrpc`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "call",
          params: { service, method, args },
          id: this.nextId++,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new OdooError(
          `Odoo request timed out after ${this.config.timeoutMs}ms`,
        );
      }
      throw new OdooError(
        `Failed to reach Odoo at ${this.config.url}: ${(err as Error).message}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new OdooError(
        `Odoo returned HTTP ${response.status} ${response.statusText}`,
      );
    }

    const payload = (await response.json()) as JsonRpcResponse;
    if (payload.error) {
      const { message, data } = payload.error;
      const detail = data?.message ?? data?.name ?? message;
      throw new OdooError(`Odoo error: ${detail}`, payload.error);
    }
    return payload.result;
  }

  /** Authenticate and cache the uid. Throws if credentials are rejected. */
  async authenticate(force = false): Promise<number> {
    if (this.uid !== null && !force) return this.uid;
    const result = await this.rpc("common", "authenticate", [
      this.config.db,
      this.config.username,
      this.config.apiKey,
      {},
    ]);
    if (typeof result !== "number" || result === 0) {
      throw new OdooError(
        "Authentication failed: Odoo rejected the credentials (check ODOO_DB, ODOO_USERNAME, ODOO_API_KEY).",
      );
    }
    this.uid = result;
    return result;
  }

  /** Generic `execute_kw` wrapper — the building block for every data tool. */
  async executeKw(
    model: string,
    method: string,
    args: unknown[] = [],
    kwargs: Record<string, unknown> = {},
  ): Promise<unknown> {
    const uid = await this.authenticate();
    return this.rpc("object", "execute_kw", [
      this.config.db,
      uid,
      this.config.apiKey,
      model,
      method,
      args,
      kwargs,
    ]);
  }

  // --- Convenience wrappers used by the MCP tools ----------------------------

  search(
    model: string,
    domain: unknown[] = [],
    opts: { limit?: number; offset?: number; order?: string } = {},
  ): Promise<number[]> {
    return this.executeKw(model, "search", [domain], opts) as Promise<number[]>;
  }

  searchRead(
    model: string,
    domain: unknown[] = [],
    opts: {
      fields?: string[];
      limit?: number;
      offset?: number;
      order?: string;
    } = {},
  ): Promise<Record<string, unknown>[]> {
    return this.executeKw(model, "search_read", [domain], opts) as Promise<
      Record<string, unknown>[]
    >;
  }

  read(
    model: string,
    ids: number[],
    fields?: string[],
  ): Promise<Record<string, unknown>[]> {
    const kwargs = fields ? { fields } : {};
    return this.executeKw(model, "read", [ids], kwargs) as Promise<
      Record<string, unknown>[]
    >;
  }

  create(model: string, values: Record<string, unknown>): Promise<number> {
    return this.executeKw(model, "create", [values]) as Promise<number>;
  }

  write(
    model: string,
    ids: number[],
    values: Record<string, unknown>,
  ): Promise<boolean> {
    return this.executeKw(model, "write", [ids, values]) as Promise<boolean>;
  }

  unlink(model: string, ids: number[]): Promise<boolean> {
    return this.executeKw(model, "unlink", [ids]) as Promise<boolean>;
  }

  fieldsGet(
    model: string,
    attributes?: string[],
  ): Promise<Record<string, unknown>> {
    const kwargs = attributes ? { attributes } : {};
    return this.executeKw(model, "fields_get", [], kwargs) as Promise<
      Record<string, unknown>
    >;
  }
}
