import type { PoolClient } from "pg";

export interface ExistingRequest {
  user_external_id: string;
  units: string;
  decision: unknown;
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