import { Router } from "express";
import { z } from "zod";
import type { Pool } from "pg";
import { requireAccountApiKey } from "../middleware/auth";
import { validateBody } from "../middleware/validate";
import { consume } from "../consume/consumeService";
import type { ConsumptionStrategy } from "../consume/strategy";
import { lockingStrategy } from "../consume/lockingStrategy";

const consumeSchema = z.object({
  user_id: z.string().trim().min(1).max(120),
  units: z.number().int().safe().min(1).max(Number.MAX_SAFE_INTEGER),
  request_id: z.string().trim().min(1).max(200),
}).strict();

export function createConsumeRouter(
  pool: Pool,
  strategy: ConsumptionStrategy = lockingStrategy,
): Router {
  const router = Router();

  router.post(
    "/consume",
    requireAccountApiKey(pool),
    validateBody(consumeSchema),
    async (req, res) => {
      const result = await consume(pool, {
        accountId: res.locals.account.id,
        userExternalId: req.body.user_id,
        units: req.body.units,
        requestId: req.body.request_id,
      }, strategy);
      res.status(200).json(result);
    },
  );

  return router;
}