export type QuotaLevel = "account" | "user";
export type QuotaRule = "per_request" | "monthly_allowance";

export interface ConsumptionPlan {
  id: string;
  name: string;
  monthly_allowance: number;
  max_per_request: number;
}

export interface ConsumptionUsage {
  user: number;
  account: number;
}

export interface Rejection {
  level: QuotaLevel;
  rule: QuotaRule;
}

export interface ConsumptionDecision {
  accepted: boolean;
  rejected_by?: Rejection;
  account: {
    plan: string;
    used: number;
    remaining: number;
    monthly_allowance: number;
    max_per_request: number;
  };
  user: {
    plan: string;
    used: number;
    remaining: number;
    monthly_allowance: number;
    max_per_request: number;
  };
}

export function evaluateConsumption(
  units: number,
  usage: ConsumptionUsage,
  accountPlan: ConsumptionPlan,
  userPlan: ConsumptionPlan,
): ConsumptionDecision {
  let rejectedBy: Rejection | undefined;

  if (units > userPlan.max_per_request) {
    rejectedBy = { level: "user", rule: "per_request" };
  } else if (units > accountPlan.max_per_request) {
    rejectedBy = { level: "account", rule: "per_request" };
  } else if (
    usage.user > userPlan.monthly_allowance ||
    units > userPlan.monthly_allowance - usage.user
  ) {
    rejectedBy = { level: "user", rule: "monthly_allowance" };
  } else if (
    usage.account > accountPlan.monthly_allowance ||
    units > accountPlan.monthly_allowance - usage.account
  ) {
    rejectedBy = { level: "account", rule: "monthly_allowance" };
  }

  return {
    accepted: rejectedBy === undefined,
    ...(rejectedBy ? { rejected_by: rejectedBy } : {}),
    account: {
      plan: accountPlan.name,
      used: usage.account,
      remaining: Math.max(0, accountPlan.monthly_allowance - usage.account),
      monthly_allowance: accountPlan.monthly_allowance,
      max_per_request: accountPlan.max_per_request,
    },
    user: {
      plan: userPlan.name,
      used: usage.user,
      remaining: Math.max(0, userPlan.monthly_allowance - usage.user),
      monthly_allowance: userPlan.monthly_allowance,
      max_per_request: userPlan.max_per_request,
    },
  };
}

export function isConsumptionDecision(value: unknown): value is ConsumptionDecision {
  if (!value || typeof value !== "object") {
    return false;
  }
  const decision = value as Partial<ConsumptionDecision>;
  const hasValidLevel = decision.rejected_by?.level === "account" ||
    decision.rejected_by?.level === "user";
  const hasValidRule = decision.rejected_by?.rule === "per_request" ||
    decision.rejected_by?.rule === "monthly_allowance";
  const hasValidSide = (side: ConsumptionDecision["account"] | undefined): boolean =>
    !!side &&
    typeof side.plan === "string" &&
    Number.isSafeInteger(side.monthly_allowance) &&
    Number.isSafeInteger(side.max_per_request) &&
    Number.isSafeInteger(side.used) &&
    Number.isSafeInteger(side.remaining) &&
    side.monthly_allowance >= 0 &&
    side.max_per_request > 0 &&
    side.used >= 0 &&
    side.remaining >= 0;

  return (
    typeof decision.accepted === "boolean" &&
    hasValidSide(decision.account) &&
    hasValidSide(decision.user) &&
    (decision.accepted
      ? decision.rejected_by === undefined
      : hasValidLevel && hasValidRule)
  );
}