import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { OdooConfig } from "./config.js";
import { OdooClient } from "./odooClient.js";

export const SERVER_NAME = "baboo-odoo-mcp";
export const SERVER_VERSION = "0.1.0";

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Clamp a requested limit to the configured ceiling. */
function clampLimit(
  limit: number | undefined,
  max: number,
): number | undefined {
  if (limit === undefined) return undefined;
  return Math.min(limit, max);
}

/**
 * Build a fully-wired MCP server exposing the Odoo tools.
 * Pass an explicit client in tests; production uses one built from config.
 */
export function buildServer(
  config: OdooConfig,
  client: OdooClient = new OdooClient(config),
): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  const guardWrite = (): ToolResult | null =>
    config.readonly
      ? fail(
          "Server is in read-only mode (ODOO_MCP_READONLY). Write operations are disabled.",
        )
      : null;

  const wrap =
    (handler: (args: any) => Promise<ToolResult>) =>
    async (args: any): Promise<ToolResult> => {
      try {
        return await handler(args);
      } catch (err) {
        return fail((err as Error).message ?? String(err));
      }
    };

  server.registerTool(
    "odoo_search",
    {
      title: "Search Odoo records",
      description:
        'Search a model and return matching record ids. `domain` is an Odoo domain, e.g. [["is_company","=",true]].',
      inputSchema: {
        model: z
          .string()
          .describe("Odoo model name, e.g. res.partner, sale.order"),
        domain: z
          .array(z.any())
          .optional()
          .describe("Odoo search domain (default: all records)"),
        limit: z.number().int().positive().optional(),
        offset: z.number().int().nonnegative().optional(),
        order: z.string().optional().describe("e.g. 'create_date desc'"),
      },
    },
    wrap(async ({ model, domain, limit, offset, order }) => {
      const ids = await client.search(model, domain ?? [], {
        limit: clampLimit(limit, config.maxLimit),
        offset,
        order,
      });
      return ok(ids);
    }),
  );

  server.registerTool(
    "odoo_search_read",
    {
      title: "Search and read Odoo records",
      description:
        "Search a model and read selected fields in one call. Returns an array of records.",
      inputSchema: {
        model: z.string(),
        domain: z.array(z.any()).optional(),
        fields: z
          .array(z.string())
          .optional()
          .describe("Fields to return (default: a sensible subset)"),
        limit: z.number().int().positive().optional(),
        offset: z.number().int().nonnegative().optional(),
        order: z.string().optional(),
      },
    },
    wrap(async ({ model, domain, fields, limit, offset, order }) => {
      const records = await client.searchRead(model, domain ?? [], {
        fields,
        limit: clampLimit(limit, config.maxLimit) ?? config.maxLimit,
        offset,
        order,
      });
      return ok(records);
    }),
  );

  server.registerTool(
    "odoo_read",
    {
      title: "Read Odoo records by id",
      description: "Read specific records by their ids.",
      inputSchema: {
        model: z.string(),
        ids: z.array(z.number().int()).min(1),
        fields: z.array(z.string()).optional(),
      },
    },
    wrap(async ({ model, ids, fields }) =>
      ok(await client.read(model, ids, fields)),
    ),
  );

  server.registerTool(
    "odoo_create",
    {
      title: "Create an Odoo record",
      description: "Create a record and return its new id.",
      inputSchema: {
        model: z.string(),
        values: z.record(z.any()).describe("Field values for the new record"),
      },
    },
    wrap(async ({ model, values }) => {
      const blocked = guardWrite();
      if (blocked) return blocked;
      return ok({ id: await client.create(model, values) });
    }),
  );

  server.registerTool(
    "odoo_write",
    {
      title: "Update Odoo records",
      description: "Update fields on one or more records.",
      inputSchema: {
        model: z.string(),
        ids: z.array(z.number().int()).min(1),
        values: z.record(z.any()),
      },
    },
    wrap(async ({ model, ids, values }) => {
      const blocked = guardWrite();
      if (blocked) return blocked;
      return ok({ success: await client.write(model, ids, values) });
    }),
  );

  server.registerTool(
    "odoo_unlink",
    {
      title: "Delete Odoo records",
      description: "Delete one or more records by id. Irreversible.",
      inputSchema: {
        model: z.string(),
        ids: z.array(z.number().int()).min(1),
      },
    },
    wrap(async ({ model, ids }) => {
      const blocked = guardWrite();
      if (blocked) return blocked;
      return ok({ success: await client.unlink(model, ids) });
    }),
  );

  server.registerTool(
    "odoo_call_method",
    {
      title: "Call an arbitrary Odoo model method",
      description:
        "Escape hatch: call any model method via execute_kw (reports, actions, server methods). Use named methods like 'name_search', 'action_confirm', etc.",
      inputSchema: {
        model: z.string(),
        method: z.string(),
        args: z
          .array(z.any())
          .optional()
          .describe("Positional args array passed to the method"),
        kwargs: z.record(z.any()).optional().describe("Keyword args object"),
      },
    },
    wrap(async ({ model, method, args, kwargs }) =>
      ok(await client.executeKw(model, method, args ?? [], kwargs ?? {})),
    ),
  );

  server.registerTool(
    "odoo_fields_get",
    {
      title: "Inspect a model's fields",
      description:
        "Return field definitions (type, label, relation, required) for a model.",
      inputSchema: {
        model: z.string(),
        attributes: z
          .array(z.string())
          .optional()
          .describe(
            "Field attributes to include, e.g. ['string','type','required','relation']",
          ),
      },
    },
    wrap(async ({ model, attributes }) =>
      ok(
        await client.fieldsGet(
          model,
          attributes ?? ["string", "type", "required", "relation", "help"],
        ),
      ),
    ),
  );

  server.registerTool(
    "odoo_list_models",
    {
      title: "List available Odoo models",
      description:
        "List installed models from ir.model, optionally filtered by a substring of the model name.",
      inputSchema: {
        filter: z
          .string()
          .optional()
          .describe(
            "Case-insensitive substring to match against the model name",
          ),
        limit: z.number().int().positive().optional(),
      },
    },
    wrap(async ({ filter, limit }) => {
      const domain = filter ? [["model", "ilike", filter]] : [];
      const models = await client.searchRead("ir.model", domain, {
        fields: ["model", "name"],
        limit: clampLimit(limit, config.maxLimit) ?? 200,
        order: "model asc",
      });
      return ok(models);
    }),
  );

  return server;
}
