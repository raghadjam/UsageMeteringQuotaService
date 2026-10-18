import { createServer } from "node:http";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { runMigrations } from "./db/migrate";
import { createPool } from "./db/pool";
import { lockingStrategy } from "./consume/lockingStrategy";
import { conditionalStrategy } from "./consume/conditionalStrategy";

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl, config.databasePoolMax);

  try {
    await runMigrations(pool);
    const consumptionStrategy = config.consumptionStrategy === "conditional"
      ? conditionalStrategy
      : lockingStrategy;
    const server = createServer(
      createApp({
        pool,
        adminApiKey: config.adminApiKey,
        consumptionStrategy,
        apiKeyCacheEnabled: config.apiKeyCacheEnabled,
      }),
    );
    server.listen(config.port, () => {
      console.log(
        `Usage metering service listening on port ${config.port} with ${config.consumptionStrategy} consumption`,
      );
    });

    const shutdown = (): void => {
      server.close((error) => {
        if (error) {
          console.error("Failed to close HTTP server", error);
          process.exitCode = 1;
        }
        void pool.end().catch((poolError: unknown) => {
          console.error("Failed to close database pool", poolError);
          process.exitCode = 1;
        });
      });
    };

    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } catch (error) {
    await pool.end();
    throw error;
  }
}

main().catch((error: unknown) => {
  console.error("Failed to start usage metering service", error);
  process.exitCode = 1;
});