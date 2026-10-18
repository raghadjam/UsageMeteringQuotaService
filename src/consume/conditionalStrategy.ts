import {
  incrementAccountUsageWithinAllowance,
  incrementUserUsageWithinAllowance,
} from "../db/queries/usage";
import { lockingStrategy } from "./lockingStrategy";
import { evaluateConsumption } from "./rules";
import type { ConsumptionStrategy } from "./strategy";

function asSafeNumber(value: string, name: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`Database returned an invalid ${name}`);
  }
  return number;
}

export const conditionalStrategy: ConsumptionStrategy = async (context) => {
  const {
    client,
    accountId,
    userId,
    month,
    units,
    accountPlan,
    userPlan,
  } = context;

  if (
    units > userPlan.max_per_request ||
    units > accountPlan.max_per_request
  ) {
    return lockingStrategy(context);
  }

  await client.query("SAVEPOINT conditional_usage");

  const userAfter = await incrementUserUsageWithinAllowance(
    client,
    userId,
    month,
    units,
    userPlan.monthly_allowance,
  );
  if (userAfter === undefined) {
    await client.query("ROLLBACK TO SAVEPOINT conditional_usage");
    return lockingStrategy(context);
  }

  const accountAfter = await incrementAccountUsageWithinAllowance(
    client,
    accountId,
    month,
    units,
    accountPlan.monthly_allowance,
  );
  if (accountAfter === undefined) {
    await client.query("ROLLBACK TO SAVEPOINT conditional_usage");
    return lockingStrategy(context);
  }

  const userUsed = asSafeNumber(userAfter, "updated user usage");
  const accountUsed = asSafeNumber(accountAfter, "updated account usage");
  const decision = evaluateConsumption(
    units,
    { user: userUsed - units, account: accountUsed - units },
    accountPlan,
    userPlan,
  );
  if (!decision.accepted) {
    throw new Error("Conditional usage update accepted a request rejected by quota rules");
  }

  decision.user.used = userUsed;
  decision.user.remaining = Math.max(
    0,
    decision.user.monthly_allowance - userUsed,
  );
  decision.account.used = accountUsed;
  decision.account.remaining = Math.max(
    0,
    decision.account.monthly_allowance - accountUsed,
  );
  return { decision, usageWrite: { kind: "already_applied" } };
};