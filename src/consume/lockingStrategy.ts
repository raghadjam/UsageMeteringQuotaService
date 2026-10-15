import {
  incrementUsage,
  lockAccountUsage,
  lockUserUsage,
} from "../db/queries/usage";
import { evaluateConsumption, type ConsumptionDecision } from "./rules";
import type { ConsumptionStrategy } from "./strategy";

function asSafeNumber(value: string, name: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`Database returned an invalid ${name}`);
  }
  return number;
}

export const lockingStrategy: ConsumptionStrategy = async ({
  client,
  accountId,
  userId,
  month,
  units,
  accountPlan,
  userPlan,
}): Promise<ConsumptionDecision> => {
  const userUsedBefore = await lockUserUsage(client, userId, month);
  const accountUsedBefore = await lockAccountUsage(client, accountId, month);
  const decision = evaluateConsumption(
    units,
    {
      user: asSafeNumber(userUsedBefore, "user usage"),
      account: asSafeNumber(accountUsedBefore, "account usage"),
    },
    accountPlan,
    userPlan,
  );

  if (decision.accepted) {
    const updatedUsage = await incrementUsage(
      client,
      accountId,
      userId,
      month,
      units,
    );
    decision.user.used = asSafeNumber(updatedUsage.user, "updated user usage");
    decision.user.remaining = Math.max(
      0,
      decision.user.monthly_allowance - decision.user.used,
    );
    decision.account.used = asSafeNumber(updatedUsage.account, "updated account usage");
    decision.account.remaining = Math.max(
      0,
      decision.account.monthly_allowance - decision.account.used,
    );
  }

  return decision;
};