import {
  ensureAccountUsageRow,
  ensureUserUsageRow,
  lockAccountUsage,
  lockUserUsage,
} from "../db/queries/usage";
import { evaluateConsumption } from "./rules";
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
}) => {
  let userUsedBefore = await lockUserUsage(client, userId, month);
  if (userUsedBefore === undefined) {
    await ensureUserUsageRow(client, userId, month);
    userUsedBefore = await lockUserUsage(client, userId, month);
  }
  if (userUsedBefore === undefined) {
    throw new Error("User usage row could not be initialized");
  }

  let accountUsedBefore = await lockAccountUsage(client, accountId, month);
  if (accountUsedBefore === undefined) {
    await ensureAccountUsageRow(client, accountId, month);
    accountUsedBefore = await lockAccountUsage(client, accountId, month);
  }
  if (accountUsedBefore === undefined) {
    throw new Error("Account usage row could not be initialized");
  }
  const decision = evaluateConsumption(
    units,
    {
      user: asSafeNumber(userUsedBefore, "user usage"),
      account: asSafeNumber(accountUsedBefore, "account usage"),
    },
    accountPlan,
    userPlan,
  );

  if (!decision.accepted) {
    return { decision, usageWrite: null };
  }

  const userUnitsUsed = decision.user.used + units;
  const accountUnitsUsed = decision.account.used + units;
  decision.user.used = userUnitsUsed;
  decision.user.remaining = Math.max(
    0,
    decision.user.monthly_allowance - userUnitsUsed,
  );
  decision.account.used = accountUnitsUsed;
  decision.account.remaining = Math.max(
    0,
    decision.account.monthly_allowance - accountUnitsUsed,
  );

  return {
    decision,
    usageWrite: {
      kind: "write",
      userUnitsUsed,
      accountUnitsUsed,
    },
  };
};