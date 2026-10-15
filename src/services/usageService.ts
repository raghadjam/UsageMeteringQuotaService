import type { Pool } from "pg";
import {
  getAccountUsageSnapshot,
  getUserUsageSnapshot,
  type AccountUsageSnapshot,
  type UserUsageSnapshot,
} from "../db/queries/usage";
import { AppError } from "../errors";

function safeNumber(value: string, name: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`Database returned an invalid ${name}`);
  }
  return number;
}

function serializeUsageSide(
  plan: { id: string; name: string; monthlyAllowance: string; maxPerRequest: string },
  unitsUsed: string | null,
  isCurrentMonth: boolean,
) {
  const used = unitsUsed === null ? 0 : safeNumber(unitsUsed, "units used");
  const monthlyAllowance = safeNumber(plan.monthlyAllowance, "monthly allowance");
  return {
    plan: {
      id: plan.id,
      name: plan.name,
      monthly_allowance: monthlyAllowance,
      max_per_request: safeNumber(plan.maxPerRequest, "max per request"),
    },
    units_used: used,
    remaining: isCurrentMonth ? Math.max(0, monthlyAllowance - used) : null,
  };
}

function serializeAccountUser(
  row: AccountUsageSnapshot,
  isCurrentMonth: boolean,
) {
  if (
    row.user_id === null ||
    row.external_id === null ||
    row.user_plan_id === null ||
    row.user_plan_name === null ||
    row.user_monthly_allowance === null ||
    row.user_max_per_request === null
  ) {
    throw new Error("Database returned an incomplete user usage snapshot");
  }
  const used = row.user_units_used === null
    ? 0
    : safeNumber(row.user_units_used, "user units used");
  const allowance = safeNumber(row.user_monthly_allowance, "user monthly allowance");
  return {
    user_id: row.external_id,
    plan: {
      id: row.user_plan_id,
      name: row.user_plan_name,
      monthly_allowance: allowance,
      max_per_request: safeNumber(row.user_max_per_request, "user max per request"),
    },
    units_used: used,
    remaining: isCurrentMonth ? Math.max(0, allowance - used) : null,
  };
}

function assertAccountExists(rows: AccountUsageSnapshot[]): void {
  if (rows.length === 0) {
    throw new AppError(401, "invalid_api_key", "Missing or invalid API key");
  }
}

function assertUserExists(
  row: UserUsageSnapshot | undefined,
): asserts row is UserUsageSnapshot {
  if (!row) {
    throw new AppError(404, "user_not_found", "User not found in this account");
  }
}

export async function getAccountUsage(
  pool: Pool,
  accountId: string,
  month?: string,
) {
  const rows = await getAccountUsageSnapshot(
    pool,
    accountId,
    month ? `${month}-01` : undefined,
  );
  assertAccountExists(rows);
  const first = rows[0];
  return {
    month: first.month,
    account: serializeUsageSide(
      {
        id: first.account_plan_id,
        name: first.account_plan_name,
        monthlyAllowance: first.account_monthly_allowance,
        maxPerRequest: first.account_max_per_request,
      },
      first.account_units_used,
      first.is_current_month,
    ),
    users: rows
      .filter((row) => row.user_id !== null)
      .map((row) => serializeAccountUser(row, first.is_current_month)),
  };
}

export async function getSingleUserUsage(
  pool: Pool,
  accountId: string,
  externalId: string,
  month?: string,
) {
  const row = await getUserUsageSnapshot(
    pool,
    accountId,
    externalId,
    month ? `${month}-01` : undefined,
  );
  assertUserExists(row);
  return {
    month: row.month,
    account: serializeUsageSide(
      {
        id: row.account_plan_id,
        name: row.account_plan_name,
        monthlyAllowance: row.account_monthly_allowance,
        maxPerRequest: row.account_max_per_request,
      },
      row.account_units_used,
      row.is_current_month,
    ),
    user: serializeUsageSide(
      {
        id: row.user_plan_id,
        name: row.user_plan_name,
        monthlyAllowance: row.user_monthly_allowance,
        maxPerRequest: row.user_max_per_request,
      },
      row.user_units_used,
      row.is_current_month,
    ),
  };
}