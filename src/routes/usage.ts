import { Router } from "express";
import { z } from "zod";
import type { Pool } from "pg";
import { AppError } from "../errors";
import { requireAccountApiKey } from "../middleware/auth";
import type { AccountIdCache } from "../middleware/auth";
import { getAccountUsage, getSingleUserUsage } from "../services/usageService";
import { parseMonth } from "../services/requestService";

const monthSchema = z.object({
  month: z.string().optional(),
}).strict();

function getMonth(query: unknown): string | undefined {
  const parsed = monthSchema.safeParse(query);
  if (!parsed.success) {
    throw new AppError(400, "invalid_query", "Usage query is invalid");
  }
  return parseMonth(parsed.data.month);
}

export function createUsageRouter(
  pool: Pool,
  accountIdCache: AccountIdCache | null,
): Router {
  const router = Router();
  const authenticate = requireAccountApiKey(pool, accountIdCache);

  router.get("/usage", authenticate, async (req, res) => {
    const usage = await getAccountUsage(
      pool,
      res.locals.account.id,
      getMonth(req.query),
    );
    res.json(usage);
  });

  router.get("/users/:externalId/usage", authenticate, async (req, res) => {
    const externalId = z.string().min(1).max(120).safeParse(req.params.externalId);
    if (!externalId.success) {
      throw new AppError(400, "invalid_external_id", "User identifier is invalid");
    }
    const usage = await getSingleUserUsage(
      pool,
      res.locals.account.id,
      externalId.data,
      getMonth(req.query),
    );
    res.json(usage);
  });

  return router;
}