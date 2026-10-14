import express from "express";
import type { Pool } from "pg";
import { createAccountsRouter } from "./routes/accounts";
import { errorHandler } from "./middleware/errorHandler";

export interface AppDependencies {
  pool: Pool;
  adminApiKey: string;
}

export function createApp({ pool, adminApiKey }: AppDependencies): express.Express {
  const app = express();
  app.use(express.json({ limit: "16kb" }));
  app.use("/v1", createAccountsRouter(pool, adminApiKey));
  app.use((_req, res) => {
    res.status(404).json({
      error: { code: "not_found", message: "Route not found" },
    });
  });
  app.use(errorHandler);
  return app;
}