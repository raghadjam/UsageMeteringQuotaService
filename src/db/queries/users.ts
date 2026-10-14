import type { Pool } from "pg";

export interface UserRecord {
  id: string;
  account_id: string;
  external_id: string;
  plan_id: string;
  plan_name: string;
  monthly_allowance: string;
  max_per_request: string;
  created_at: string;
}

export interface UserCursor {
  createdAt: string;
  id: string;
}

export async function insertUser(
  pool: Pool,
  accountId: string,
  externalId: string,
  planId?: string,
): Promise<UserRecord | undefined> {
  const result = await pool.query<UserRecord>(
    `WITH eligible_plan AS (
       SELECT p.id
       FROM plans p
       WHERE p.kind = 'user'
         AND (
           ($3::uuid IS NULL AND p.owner_account_id IS NULL AND p.name = 'Basic')
           OR (
             $3::uuid IS NOT NULL
             AND p.id = $3::uuid
             AND (p.owner_account_id IS NULL OR p.owner_account_id = $1)
           )
         )
       LIMIT 1
     ),
     inserted AS (
       INSERT INTO users (account_id, external_id, plan_id)
       SELECT $1, $2, eligible_plan.id
       FROM eligible_plan
       RETURNING id, account_id, external_id, plan_id, created_at
     )
     SELECT inserted.id, inserted.account_id, inserted.external_id,
            inserted.plan_id, p.name AS plan_name,
            p.monthly_allowance, p.max_per_request,
            to_char(inserted.created_at AT TIME ZONE 'UTC',
                    'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS created_at
     FROM inserted
     JOIN plans p ON p.id = inserted.plan_id`,
    [accountId, externalId, planId ?? null],
  );

  return result.rows[0];
}

export async function findUser(
  pool: Pool,
  accountId: string,
  externalId: string,
): Promise<UserRecord | undefined> {
  const result = await pool.query<UserRecord>(
    `SELECT u.id, u.account_id, u.external_id, u.plan_id,
            p.name AS plan_name, p.monthly_allowance,
            p.max_per_request,
            to_char(u.created_at AT TIME ZONE 'UTC',
                    'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS created_at
     FROM users u
     JOIN plans p ON p.id = u.plan_id
     WHERE u.account_id = $1 AND u.external_id = $2`,
    [accountId, externalId],
  );
  return result.rows[0];
}

export async function listUsers(
  pool: Pool,
  accountId: string,
  limit: number,
  cursor?: UserCursor,
): Promise<UserRecord[]> {
  const result = await pool.query<UserRecord>(
    `SELECT u.id, u.account_id, u.external_id, u.plan_id,
            p.name AS plan_name, p.monthly_allowance,
            p.max_per_request,
            to_char(u.created_at AT TIME ZONE 'UTC',
                    'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS created_at
     FROM users u
     JOIN plans p ON p.id = u.plan_id
     WHERE u.account_id = $1
       AND (
         $2::timestamptz IS NULL
         OR (u.created_at, u.id) > ($2::timestamptz, $3::uuid)
       )
     ORDER BY u.created_at ASC, u.id ASC
     LIMIT $4`,
    [accountId, cursor?.createdAt ?? null, cursor?.id ?? null, limit],
  );
  return result.rows;
}