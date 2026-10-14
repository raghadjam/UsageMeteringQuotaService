import { Router } from "express";
import { z } from "zod";
import type { Pool } from "pg";
import { requireAccountApiKey, requireAdminApiKey } from "../middleware/auth";
import { validateBody } from "../middleware/validate";
import { createAccount } from "../services/accountService";

const createAccountSchema = z.object({
  name: z.string().trim().min(1).max(120),
}).strict();

export function createAccountsRouter(pool: Pool, adminApiKey: string): Router {
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

  router.get("/account", requireAccountApiKey(pool), async (_req, res) => {
    res.json({
      id: res.locals.account.id,
      name: res.locals.account.name,
      plan: {
        id: res.locals.account.plan.id,
        name: res.locals.account.plan.name,
        monthly_allowance: res.locals.account.plan.monthlyAllowance,
        max_per_request: res.locals.account.plan.maxPerRequest,
      },
    });
  });

  return router;
}