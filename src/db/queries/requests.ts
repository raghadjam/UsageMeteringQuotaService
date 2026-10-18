import type { Pool, PoolClient } from "pg";
import type { ConsumptionDecision } from "../../consume/rules";

export interface ExistingRequest {
  user_external_id: string;
  units: string;
  decision: unknown;
}

export interface RequestHistoryFilters {
  accountId: string;
  userExternalId?: string;
  month?: string;
  outcome?: "accepted" | "rejected";
  limit: number;
  cursor?: { createdAt: string; id: string };
}

export interface RequestHistoryRecord {
  id: string;
  request_id: string;
  user_id: string;
  units: string;
  month: string;
  outcome: "accepted" | "rejected";
  rejected_level: "account" | "user" | null;
  rejected_rule: "per_request" | "monthly_allowance" | null;
  decision: unknown;
  created_at: string;
}

export async function listRequestHistory(
  pool: Pool,
  filters: RequestHistoryFilters,
): Promise<RequestHistoryRecord[]> {
  const result = await pool.query<RequestHistoryRecord>(
    `SELECT r.id, r.request_id, u.external_id AS user_id,
            r.units::text AS units, to_char(r.month, 'YYYY-MM') AS month,
            r.outcome, r.rejected_level, r.rejected_rule, r.decision,
            to_char(r.created_at AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
     FROM requests r
     JOIN users u ON u.id = r.user_id
     WHERE r.account_id = $1
       AND r.outcome IS NOT NULL
       AND ($2::text IS NULL OR u.external_id = $2)
       AND ($3::date IS NULL OR r.month = $3::date)
       AND ($4::text IS NULL OR r.outcome = $4)
       AND (
         $5::timestamptz IS NULL
         OR (r.created_at, r.id) < ($5::timestamptz, $6::uuid)
       )
     ORDER BY r.created_at DESC, r.id DESC
     LIMIT $7`,
    [
      filters.accountId,
      filters.userExternalId ?? null,
      filters.month ? `${filters.month}-01` : null,
      filters.outcome ?? null,
      filters.cursor?.createdAt ?? null,
      filters.cursor?.id ?? null,
      filters.limit,
    ],
  );
  return result.rows;
}

export async function claimRequest(
  client: PoolClient,
  accountId: string,
  requestId: string,
  userId: string,
  units: number,
  month: string,
): Promise<boolean> {
  const result = await client.query(
    `INSERT INTO requests (account_id, request_id, user_id, units, month)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (account_id, request_id) DO NOTHING
     RETURNING id`,
    [accountId, requestId, userId, units, month],
  );
  return result.rowCount === 1;
}

export async function findRequest(
  client: PoolClient,
  accountId: string,
  requestId: string,
): Promise<ExistingRequest | undefined> {
  const result = await client.query<ExistingRequest>(
    `SELECT u.external_id AS user_external_id, r.units::text AS units, r.decision
     FROM requests r
     JOIN users u ON u.id = r.user_id
     WHERE r.account_id = $1 AND r.request_id = $2`,
    [accountId, requestId],
  );
  return result.rows[0];
}

export async function completeRequest(
  client: PoolClient,
  accountId: string,
  requestId: string,
  decision: object,
  rejectedBy?: { level: "account" | "user"; rule: "per_request" | "monthly_allowance" },
): Promise<boolean> {
  const result = await client.query(
    `UPDATE requests
     SET outcome = $3,
         rejected_level = $4,
         rejected_rule = $5,
         decision = $6
     WHERE account_id = $1 AND request_id = $2`,
    [
      accountId,
      requestId,
      rejectedBy ? "rejected" : "accepted",
      rejectedBy?.level ?? null,
      rejectedBy?.rule ?? null,
      JSON.stringify(decision),
    ],
  );
  return result.rowCount === 1;
}

export async function completeAcceptedRequestWithUsage(
  client: PoolClient,
  values: {
    accountId: string;
    userId: string;
    month: string;
    requestId: string;
    userUnitsUsed: number;
    accountUnitsUsed: number;
    decision: ConsumptionDecision;
  },
): Promise<boolean> {
  const result = await client.query<{
    user_count: number;
    account_count: number;
    request_count: number;
  }>(
    `WITH updated_user AS (
       UPDATE user_usage
       SET units_used = $5
       WHERE user_id = $2 AND month = $3
       RETURNING 1
     ), updated_account AS (
       UPDATE account_usage
       SET units_used = $6
       WHERE account_id = $1 AND month = $3
       RETURNING 1
     ), updated_request AS (
       UPDATE requests
       SET outcome = 'accepted',
           rejected_level = NULL,
           rejected_rule = NULL,
           decision = $7
       WHERE account_id = $1 AND request_id = $4
       RETURNING 1
     )
     SELECT (SELECT count(*)::int FROM updated_user) AS user_count,
            (SELECT count(*)::int FROM updated_account) AS account_count,
            (SELECT count(*)::int FROM updated_request) AS request_count`,
    [
      values.accountId,
      values.userId,
      values.month,
      values.requestId,
      values.userUnitsUsed,
      values.accountUnitsUsed,
      JSON.stringify(values.decision),
    ],
  );

  const counts = result.rows[0];
  return (
    counts?.user_count === 1 &&
    counts.account_count === 1 &&
    counts.request_count === 1
  );
}