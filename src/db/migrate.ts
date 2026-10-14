import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";

const MIGRATION_LOCK_ID = 741_902_618_304;

export async function runMigrations(
  pool: Pool,
  migrationDirectory = path.join(__dirname, "migrations"),
): Promise<void> {
  const files = (await readdir(migrationDirectory))
    .filter((file) => /^\d+_[a-z0-9_]+\.sql$/.test(file))
    .sort();

  if (files.length === 0) {
    throw new Error(`No SQL migrations found in ${migrationDirectory}`);
  }

  const client = await pool.connect();
  let lockAcquired = false;

  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    lockAcquired = true;
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const result = await client.query<{ name: string }>(
      "SELECT name FROM schema_migrations",
    );
    const applied = new Set(result.rows.map((row) => row.name));

    for (const file of files) {
      if (applied.has(file)) {
        continue;
      }

      const migration = await readFile(path.join(migrationDirectory, file), "utf8");
      await client.query("BEGIN");

      try {
        await client.query(migration);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    try {
      if (lockAcquired) {
        await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]);
      }
    } finally {
      client.release();
    }
  }
}