import { createPool } from "./pool";
import { runMigrations } from "./migrate";

async function main(): Promise<void> {
  const pool = createPool();

  try {
    await runMigrations(pool);
    console.log("Database migrations applied successfully");
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error("Failed to apply database migrations", error);
  process.exitCode = 1;
});
