import { Router } from "express";
import { z } from "zod";
import type { Pool } from "pg";
import type { PlanRecord } from "../db/queries/plans";
import { AppError } from "../errors";
import { requireAccountApiKey } from "../middleware/auth";
import type { AccountIdCache } from "../middleware/auth";
import { validateBody } from "../middleware/validate";
import {
  assignAccountPlan,
  assignUserPlan,
  createPlan,
  getPlan,
  listPlans,
  updatePlan,
} from "../services/planService";

const MAX_UNITS = Number.MAX_SAFE_INTEGER;

const planKindSchema = z.enum(["account", "user"]);
const positiveLimitSchema = z.number().int().safe().min(1).max(MAX_UNITS);
const allowanceSchema = z.number().int().safe().min(0).max(MAX_UNITS);

const createPlanSchema = z.object({
  kind: planKindSchema,
  name: z.string().trim().min(1).max(120),
  monthly_allowance: allowanceSchema,
  max_per_request: positiveLimitSchema,
}).strict();

const updatePlanSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  monthly_allowance: allowanceSchema.optional(),
  max_per_request: positiveLimitSchema.optional(),
}).strict().refine((value) => Object.keys(value).length > 0);

const assignPlanSchema = z.object({
  plan_id: z.string().uuid(),
}).strict();

const listPlansQuerySchema = z.object({
  kind: planKindSchema.optional(),
}).strict();

function serializePlan(plan: PlanRecord) {
  return {
    id: plan.id,
    kind: plan.kind,
    name: plan.name,
    monthly_allowance: Number(plan.monthly_allowance),
    max_per_request: Number(plan.max_per_request),
    is_predefined: plan.owner_account_id === null,
    created_at: plan.created_at,
  };
}

function parsePlanId(value: string | string[]): string {
  const parsed = z.string().uuid().safeParse(value);
  if (!parsed.success) {
    throw new AppError(400, "invalid_plan_id", "Plan identifier must be a UUID");
  }
  return parsed.data;
}

export function createPlansRouter(
  pool: Pool,
  accountIdCache: AccountIdCache | null,
): Router {
  const router = Router();
  const authenticate = requireAccountApiKey(pool, accountIdCache);

  router.get("/plans", authenticate, async (req, res) => {
    const parsed = listPlansQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new AppError(400, "invalid_query", "Plan list query is invalid");
    }
    const plans = await listPlans(pool, res.locals.account.id, parsed.data.kind);
    res.json({ plans: plans.map(serializePlan) });
  });

  router.post(
    "/plans",
    authenticate,
    validateBody(createPlanSchema),
    async (req, res) => {
      const plan = await createPlan(pool, res.locals.account.id, {
        kind: req.body.kind,
        name: req.body.name,
        monthlyAllowance: req.body.monthly_allowance,
        maxPerRequest: req.body.max_per_request,
      });
      res.status(201).json({ plan: serializePlan(plan) });
    },
  );

  router.get("/plans/:id", authenticate, async (req, res) => {
    const plan = await getPlan(
      pool,
      res.locals.account.id,
      parsePlanId(req.params.id),
    );
    res.json({ plan: serializePlan(plan) });
  });

  router.patch(
    "/plans/:id",
    authenticate,
    validateBody(updatePlanSchema),
    async (req, res) => {
      const plan = await updatePlan(
        pool,
        res.locals.account.id,
        parsePlanId(req.params.id),
        {
          name: req.body.name,
          monthlyAllowance: req.body.monthly_allowance,
          maxPerRequest: req.body.max_per_request,
        },
      );
      res.json({ plan: serializePlan(plan) });
    },
  );

  router.put(
    "/account/plan",
    authenticate,
    validateBody(assignPlanSchema),
    async (_req, res) => {
      const plan = await assignAccountPlan(
        pool,
        res.locals.account.id,
        _req.body.plan_id,
      );
      res.json({ plan: serializePlan(plan) });
    },
  );

  router.put(
    "/users/:externalId/plan",
    authenticate,
    validateBody(assignPlanSchema),
    async (req, res) => {
      const externalId = z.string().min(1).max(120).safeParse(req.params.externalId);
      if (!externalId.success) {
        throw new AppError(400, "invalid_external_id", "User identifier is invalid");
      }
      const plan = await assignUserPlan(
        pool,
        res.locals.account.id,
        externalId.data,
        req.body.plan_id,
      );
      res.json({ plan: serializePlan(plan) });
    },
  );

  return router;
}