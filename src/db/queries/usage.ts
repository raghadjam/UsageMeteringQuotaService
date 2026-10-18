import type { Pool, PoolClient } from "pg";

export interface UsageAmounts {
  user: string;
  account: string;
}

export interface AccountUsageSnapshot {
  month: string;
  account_id: string;
  account_plan_id: string;
  account_plan_name: string;
  account_monthly_allowance: string;
  account_max_per_request: string;
  account_units_used: string | null;
  user_id: string | null;
  external_id: string | null;
  user_plan_id: string | null;
  user_plan_name: string | null;
  user_monthly_allowance: string | null;
  user_max_per_request: string | null;
  user_units_used: string | null;
  is_current_month: boolean;
}

export async function getAccountUsageSnapshot(
  pool: Pool,
  accountId: string,
  month?: string,
): Promise<AccountUsageSnapshot[]> {
  const result = await pool.query<AccountUsageSnapshot>(
    `WITH requested_month AS (
       SELECT COALESCE(
                $2::date,
                date_trunc('month', transaction_timestamp() AT TIME ZONE 'UTC')::date
              ) AS month
     )
     SELECT to_char(rm.month, 'YYYY-MM') AS month,
            a.id AS account_id,
            ap.id AS account_plan_id, ap.name AS account_plan_name,
            ap.monthly_allowance::text AS account_monthly_allowance,
            ap.max_per_request::text AS account_max_per_request,
            au.units_used::text AS account_units_used,
            u.id AS user_id, u.external_id,
            up.id AS user_plan_id, up.name AS user_plan_name,
            up.monthly_allowance::text AS user_monthly_allowance,
            up.max_per_request::text AS user_max_per_request,
            uu.units_used::text AS user_units_used,
            rm.month = date_trunc('month', transaction_timestamp() AT TIME ZONE 'UTC')::date
              AS is_current_month
     FROM accounts a
     CROSS JOIN requested_month rm
     JOIN plans ap ON ap.id = a.plan_id
     LEFT JOIN account_usage au
       ON au.account_id = a.id AND au.month = rm.month
     LEFT JOIN users u ON u.account_id = a.id
     LEFT JOIN plans up ON up.id = u.plan_id
     LEFT JOIN user_usage uu
       ON uu.user_id = u.id AND uu.month = rm.month
     WHERE a.id = $1
     ORDER BY u.created_at ASC, u.id ASC`,
    [accountId, month],
  );
  return result.rows;
}

export interface UserUsageSnapshot {
  month: string;
  user_id: string;
  external_id: string;
  account_plan_id: string;
  account_plan_name: string;
  account_monthly_allowance: string;
  account_max_per_request: string;
  account_units_used: string | null;
  user_plan_id: string;
  user_plan_name: string;
  user_monthly_allowance: string;
  user_max_per_request: string;
  user_units_used: string | null;
  is_current_month: boolean;
}

export async function getUserUsageSnapshot(
  pool: Pool,
  accountId: string,
  externalId: string,
  month?: string,
): Promise<UserUsageSnapshot | undefined> {
  const result = await pool.query<UserUsageSnapshot>(
    `WITH requested_month AS (
       SELECT COALESCE(
                $3::date,
                date_trunc('month', transaction_timestamp() AT TIME ZONE 'UTC')::date
              ) AS month
     )
     SELECT to_char(rm.month, 'YYYY-MM') AS month,
            u.id AS user_id, u.external_id,
            ap.id AS account_plan_id, ap.name AS account_plan_name,
            ap.monthly_allowance::text AS account_monthly_allowance,
            ap.max_per_request::text AS account_max_per_request,
            au.units_used::text AS account_units_used,
            up.id AS user_plan_id, up.name AS user_plan_name,
            up.monthly_allowance::text AS user_monthly_allowance,
            up.max_per_request::text AS user_max_per_request,
            uu.units_used::text AS user_units_used,
            rm.month = date_trunc('month', transaction_timestamp() AT TIME ZONE 'UTC')::date
              AS is_current_month
     FROM users u
     CROSS JOIN requested_month rm
     JOIN accounts a ON a.id = u.account_id
     JOIN plans ap ON ap.id = a.plan_id
     JOIN plans up ON up.id = u.plan_id
     LEFT JOIN account_usage au
       ON au.account_id = a.id AND au.month = rm.month
     LEFT JOIN user_usage uu
       ON uu.user_id = u.id AND uu.month = rm.month
     WHERE a.id = $1 AND u.external_id = $2`,
    [accountId, externalId, month],
  );
  return result.rows[0];
}

export async function ensureUserUsageRow(
  client: PoolClient,
  userId: string,
  month: string,
): Promise<void> {
  await client.query(
    `INSERT INTO user_usage (user_id, month, units_used)
     VALUES ($1, $2, 0)
     ON CONFLICT (user_id, month) DO NOTHING`,
    [userId, month],
  );
}

export async function ensureAccountUsageRow(
  client: PoolClient,
  accountId: string,
  month: string,
): Promise<void> {
  await client.query(
    `INSERT INTO account_usage (account_id, month, units_used)
     VALUES ($1, $2, 0)
     ON CONFLICT (account_id, month) DO NOTHING`,
    [accountId, month],
  );
}

export async function lockUserUsage(
  client: PoolClient,
  userId: string,
  month: string,
): Promise<string | undefined> {
  const result = await client.query<{ units_used: string }>(
    `SELECT units_used::text AS units_used
     FROM user_usage
     WHERE user_id = $1 AND month = $2
     FOR NO KEY UPDATE`,
    [userId, month],
  );
  return result.rows[0]?.units_used;
}

export async function lockAccountUsage(
  client: PoolClient,
  accountId: string,
  month: string,
): Promise<string | undefined> {
  const result = await client.query<{ units_used: string }>(
    `SELECT units_used::text AS units_used
     FROM account_usage
     WHERE account_id = $1 AND month = $2
     FOR NO KEY UPDATE`,
    [accountId, month],
  );
  return result.rows[0]?.units_used;
}

export async function incrementUsage(
  client: PoolClient,
  accountId: string,
  userId: string,
  month: string,
  units: number,
): Promise<UsageAmounts> {
  const userResult = await client.query<{ units_used: string }>(
    `UPDATE user_usage
     SET units_used = units_used + $3
     WHERE user_id = $1 AND month = $2
     RETURNING units_used::text AS units_used`,
    [userId, month, units],
  );
  const accountResult = await client.query<{ units_used: string }>(
    `UPDATE account_usage
     SET units_used = units_used + $3
     WHERE account_id = $1 AND month = $2
     RETURNING units_used::text AS units_used`,
    [accountId, month, units],
  );
  if (!userResult.rows[0] || !accountResult.rows[0]) {
    throw new Error("Usage rows disappeared during a consume transaction");
  }
  return {
    user: userResult.rows[0].units_used,
    account: accountResult.rows[0].units_used,
  };
}

export async function incrementUserUsageWithinAllowance(
  client: PoolClient,
  userId: string,
  month: string,
  units: number,
  allowance: number,
): Promise<string | undefined> {
  const result = await client.query<{ units_used: string }>(
    `UPDATE user_usage
     SET units_used = units_used + $3
     WHERE user_id = $1 AND month = $2
       AND units_used <= $4::bigint - $3::bigint
     RETURNING units_used::text AS units_used`,
    [userId, month, units, allowance],
  );
  return result.rows[0]?.units_used;
}

export async function incrementAccountUsageWithinAllowance(
  client: PoolClient,
  accountId: string,
  month: string,
  units: number,
  allowance: number,
): Promise<string | undefined> {
  const result = await client.query<{ units_used: string }>(
    `UPDATE account_usage
     SET units_used = units_used + $3
     WHERE account_id = $1 AND month = $2
       AND units_used <= $4::bigint - $3::bigint
     RETURNING units_used::text AS units_used`,
    [accountId, month, units, allowance],
  );
  return result.rows[0]?.units_used;
}

export async function readUsageAmounts(
  client: PoolClient,
  accountId: string,
  userId: string,
  month: string,
): Promise<UsageAmounts> {
  const result = await client.query<{ user: string; account: string }>(
    `SELECT uu.units_used::text AS "user",
            au.units_used::text AS account
     FROM user_usage uu
     JOIN account_usage au ON au.month = uu.month
     WHERE uu.user_id = $1 AND au.account_id = $2 AND uu.month = $3`,
    [userId, accountId, month],
  );
  if (!result.rows[0]) {
    throw new Error("Usage rows were not initialized");
  }
  return result.rows[0];
}