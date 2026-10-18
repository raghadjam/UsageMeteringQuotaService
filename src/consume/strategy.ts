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

export type ConsumptionStrategyResult =
  | {
      decision: ConsumptionDecision;
      usageWrite: {
        kind: "write";
        userUnitsUsed: number;
        accountUnitsUsed: number;
      };
    }
  | { decision: ConsumptionDecision; usageWrite: { kind: "already_applied" } }
  | { decision: ConsumptionDecision; usageWrite: null };

/**
 * Strategies decide from a transaction-consistent usage snapshot. They either
 * return totals for the service's atomic accepted-write statement, indicate
 * that usage was already updated, or return no usage write for a rejection.
 */
export type ConsumptionStrategy = (
  context: ConsumptionContext,
) => Promise<ConsumptionStrategyResult>;