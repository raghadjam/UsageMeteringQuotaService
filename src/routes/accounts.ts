import { Router } from "express";
import { z } from "zod";
import type { Pool } from "pg";
import { requireAccountApiKey, requireAdminApiKey } from "../middleware/auth";
import type { AccountIdCache } from "../middleware/auth";
import { validateBody } from "../middleware/validate";
import { createAccount, getAccount } from "../services/accountService";

const createAccountSchema = z.object({
  name: z.string().trim().min(1).max(120),
}).strict();

export function createAccountsRouter(
  pool: Pool,
  adminApiKey: string,
  accountIdCache: AccountIdCache | null,
): Router {
  const router = Router();

  router.post(
    "/accounts",
    requireAdminApiKey(adminApiKey),
    validateBody(createAccountSchema),
    async (req, res) => {
      const account = await createAccount(pool, req.body.name);
      res.status(201).json({
        id: account.id,
        name: account.name,
        api_key: account.apiKey,
        plan: {
          id: account.plan.id,
          name: account.plan.name,
          monthly_allowance: account.plan.monthlyAllowance,
          max_per_request: account.plan.maxPerRequest,
        },
      });
    },
  );

  router.get("/account", requireAccountApiKey(pool, accountIdCache), async (_req, res) => {
    const account = await getAccount(pool, res.locals.account.id);
    res.json({
      id: account.id,
      name: account.name,
      plan: {
        id: account.plan.id,
        name: account.plan.name,
        monthly_allowance: account.plan.monthlyAllowance,
        max_per_request: account.plan.maxPerRequest,
      },
    });
  });

  return router;
}