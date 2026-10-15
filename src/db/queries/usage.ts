import type { PoolClient } from "pg";

export interface UsageAmounts {
  user: string;
  account: string;
}

export async function ensureUsageRows(
  client: PoolClient,
  accountId: string,
  userId: string,
  month: string,
): Promise<void> {
  await client.query(
    `INSERT INTO user_usage (user_id, month, units_used)
     VALUES ($1, $2, 0)
     ON CONFLICT (user_id, month) DO NOTHING`,
    [userId, month],
  );
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
): Promise<string> {
  const result = await client.query<{ units_used: string }>(
    `SELECT units_used::text AS units_used
     FROM user_usage
     WHERE user_id = $1 AND month = $2
     FOR NO KEY UPDATE`,
    [userId, month],
  );
  if (!result.rows[0]) {
    throw new Error("User usage row was not initialized");
  }
  return result.rows[0].units_used;
}

export async function lockAccountUsage(
  client: PoolClient,
  accountId: string,
  month: string,
): Promise<string> {
  const result = await client.query<{ units_used: string }>(
    `SELECT units_used::text AS units_used
     FROM account_usage
     WHERE account_id = $1 AND month = $2
     FOR NO KEY UPDATE`,
    [accountId, month],
  );
  if (!result.rows[0]) {
    throw new Error("Account usage row was not initialized");
  }
  return result.rows[0].units_used;
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