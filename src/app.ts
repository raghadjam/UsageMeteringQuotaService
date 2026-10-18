import express from "express";
import type { Pool } from "pg";
import { createAccountsRouter } from "./routes/accounts";
import { createUsersRouter } from "./routes/users";
import { createPlansRouter } from "./routes/plans";
import { createConsumeRouter } from "./routes/consume";
import { createUsageRouter } from "./routes/usage";
import { createRequestsRouter } from "./routes/requests";
import { createHealthRouter } from "./routes/health";
import { errorHandler } from "./middleware/errorHandler";
import { createAccountIdCache } from "./middleware/auth";
import type { AccountIdCache } from "./middleware/auth";
import type { ConsumptionStrategy } from "./consume/strategy";
import { lockingStrategy } from "./consume/lockingStrategy";

export interface AppDependencies {
  pool: Pool;
  adminApiKey: string;
  consumptionStrategy?: ConsumptionStrategy;
  apiKeyCacheEnabled?: boolean;
}

export function createApp({
  pool,
  adminApiKey,
  consumptionStrategy = lockingStrategy,
  apiKeyCacheEnabled = true,
}: AppDependencies): express.Express {
  const accountIdCache: AccountIdCache | null = apiKeyCacheEnabled
    ? createAccountIdCache()
    : null;
  const app = express();
  app.use(express.json({ limit: "16kb" }));
  app.use("/v1", createHealthRouter(pool));
  app.use("/v1", createAccountsRouter(pool, adminApiKey, accountIdCache));
  app.use("/v1", createUsersRouter(pool, accountIdCache));
  app.use("/v1", createPlansRouter(pool, accountIdCache));
  app.use("/v1", createConsumeRouter(pool, consumptionStrategy, accountIdCache));
  app.use("/v1", createUsageRouter(pool, accountIdCache));
  app.use("/v1", createRequestsRouter(pool, accountIdCache));
  app.use((_req, res) => {
    res.status(404).json({
      error: { code: "not_found", message: "Route not found" },
    });
  });
  app.use(errorHandler);
  return app;
}