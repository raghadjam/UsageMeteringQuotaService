import type { Pool } from "pg";
import {
  assignAccountPlan as assignAccountPlanQuery,
  assignUserPlan as assignUserPlanQuery,
  findPlan,
  insertPlan,
  listPlans as listPlansQuery,
  updatePlan as updatePlanQuery,
  type PlanInput,
  type PlanKind,
  type PlanRecord,
  type PlanUpdate,
} from "../db/queries/plans";
import { AppError } from "../errors";
import { getUser } from "./userService";

function isUniqueViolation(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "23505"
  );
}

function isCheckViolation(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "23514"
  );
}

export async function listPlans(
  pool: Pool,
  accountId: string,
  kind?: PlanKind,
): Promise<PlanRecord[]> {
  return listPlansQuery(pool, accountId, kind);
}

export async function getPlan(
  pool: Pool,
  accountId: string,
  planId: string,
): Promise<PlanRecord> {
  const plan = await findPlan(pool, accountId, planId);
  if (!plan) {
    throw new AppError(404, "plan_not_found", "Plan not found");
  }
  return plan;
}

export async function createPlan(
  pool: Pool,
  accountId: string,
  input: PlanInput,
): Promise<PlanRecord> {
  try {
    const plan = await insertPlan(pool, accountId, input);
    if (!plan) {
      throw new Error("Plan insert completed without returning a plan");
    }
    return plan;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new AppError(409, "plan_name_conflict", "A plan with this name already exists");
    }
    if (isCheckViolation(error)) {
      throw new AppError(400, "invalid_plan", "Plan values violate database constraints");
    }
    throw error;
  }
}

export async function updatePlan(
  pool: Pool,
  accountId: string,
  planId: string,
  update: PlanUpdate,
): Promise<PlanRecord> {
  try {
    const plan = await updatePlanQuery(pool, accountId, planId, update);
    if (!plan) {
      throw new AppError(404, "plan_not_found", "Plan not found");
    }
    return plan;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new AppError(409, "plan_name_conflict", "A plan with this name already exists");
    }
    if (isCheckViolation(error)) {
      throw new AppError(400, "invalid_plan", "Plan values violate database constraints");
    }
    throw error;
  }
}

async function requirePlanKind(
  pool: Pool,
  accountId: string,
  planId: string,
  kind: PlanKind,
): Promise<PlanRecord> {
  const plan = await getPlan(pool, accountId, planId);
  if (plan.kind !== kind) {
    throw new AppError(404, "plan_not_found", "Plan not found");
  }
  return plan;
}

export async function assignAccountPlan(
  pool: Pool,
  accountId: string,
  planId: string,
): Promise<PlanRecord> {
  await requirePlanKind(pool, accountId, planId, "account");
  const plan = await assignAccountPlanQuery(pool, accountId, planId);
  if (!plan) {
    throw new AppError(404, "plan_not_found", "Plan not found");
  }
  return plan;
}

export async function assignUserPlan(
  pool: Pool,
  accountId: string,
  externalId: string,
  planId: string,
): Promise<PlanRecord> {
  await getUser(pool, accountId, externalId);
  await requirePlanKind(pool, accountId, planId, "user");
  const plan = await assignUserPlanQuery(pool, accountId, externalId, planId);
  if (!plan) {
    throw new AppError(404, "user_not_found", "User not found");
  }
  return plan;
}