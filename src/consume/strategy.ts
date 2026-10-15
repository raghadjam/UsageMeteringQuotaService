import type { PoolClient } from "pg";
import type { ConsumptionDecision, ConsumptionPlan } from "./rules";

export interface ConsumptionContext {
  client: PoolClient;
  accountId: string;
  userId: string;
  month: string;
  units: number;
  accountPlan: ConsumptionPlan;
  userPlan: ConsumptionPlan;
}

export type ConsumptionStrategy = (
  context: ConsumptionContext,
) => Promise<ConsumptionDecision>;