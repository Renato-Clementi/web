/**
 * Minimal, dependency-light SQL migration runner.
 *
 * Convention: ordered files in db/migrations/NNNN_name.sql. Each is applied
 * exactly once, inside a single transaction together with its bookkeeping row
 * in schema_migrations, so a migration either fully applies or not at all.
 *
 * Connects via DATABASE_URL with whatever privileges that role has. For the
 * initial migration the role must be allowed to CREATE EXTENSION vector — on
 * managed Postgres that means the admin/owner role (Neon: the project owner;
 * Supabase: run via the SQL editor / service role).
 *
 * Usage: npm run db:migrate
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "migrations",
);

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set (see .env.example).");
  }

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename    text PRIMARY KEY,
        applied_at  timestamptz NOT NULL DEFAULT now()
      );
    `);

    const applied = new Set(
      (
        await client.query<{ filename: string }>(
          "SELECT filename FROM schema_migrations",
        )
      ).rows.map((r) => r.filename),
    );

    let ran = 0;
    for (const filename of files) {
      if (applied.has(filename)) {
        console.log(`• skip   ${filename} (already applied)`);
        continue;
      }
      const sql = readFileSync(join(MIGRATIONS_DIR, filename), "utf8");
      process.stdout.write(`• apply  ${filename} … `);
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (filename) VALUES ($1)",
          [filename],
        );
        await client.query("COMMIT");
        console.log("ok");
        ran += 1;
      } catch (err) {
        await client.query("ROLLBACK");
        console.log("FAILED");
        throw err;
      }
    }
    console.log(
      `\nDone. ${ran} migration(s) applied, ${files.length - ran} already current.`,
    );
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
