/**
 * Configuration is read exclusively from environment variables.
 * No secret is ever hard-coded or logged.
 */
export interface OdooConfig {
  url: string;
  db: string;
  username: string;
  apiKey: string;
  timeoutMs: number;
  maxLimit: number;
  readonly: boolean;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `Missing required environment variable ${name}. ` +
        `Set ODOO_URL, ODOO_DB, ODOO_USERNAME and ODOO_API_KEY before starting the server.`,
    );
  }
  return value.trim();
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error(
      `Environment variable ${name} must be a positive integer, got "${raw}".`,
    );
  }
  return parsed;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): OdooConfig {
  // Temporarily expose env so required()/intEnv() read the provided object in tests.
  const previous = process.env;
  process.env = env;
  try {
    const url = required("ODOO_URL").replace(/\/+$/, "");
    return {
      url,
      db: required("ODOO_DB"),
      username: required("ODOO_USERNAME"),
      apiKey: required("ODOO_API_KEY"),
      timeoutMs: intEnv("ODOO_TIMEOUT_MS", 30_000),
      maxLimit: intEnv("ODOO_MAX_LIMIT", 1000),
      readonly: boolEnv("ODOO_MCP_READONLY", false),
    };
  } finally {
    process.env = previous;
  }
}
