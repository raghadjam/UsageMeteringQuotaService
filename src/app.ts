import express from "express";
import type { Pool } from "pg";
import { createAccountsRouter } from "./routes/accounts";
import { createUsersRouter } from "./routes/users";
import { createPlansRouter } from "./routes/plans";
import { createConsumeRouter } from "./routes/consume";
import { errorHandler } from "./middleware/errorHandler";

export interface AppDependencies {
  pool: Pool;
  adminApiKey: string;
}

export function createApp({ pool, adminApiKey }: AppDependencies): express.Express {
  const app = express();
  app.use(express.json({ limit: "16kb" }));
  app.use("/v1", createAccountsRouter(pool, adminApiKey));
  app.use("/v1", createUsersRouter(pool));
  app.use("/v1", createPlansRouter(pool));
  app.use("/v1", createConsumeRouter(pool));
  app.use((_req, res) => {
    res.status(404).json({
      error: { code: "not_found", message: "Route not found" },
    });
  });
  app.use(errorHandler);
  return app;
}