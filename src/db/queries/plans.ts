import type { Pool, PoolClient } from "pg";

export type PlanKind = "account" | "user";

export interface PlanRecord {
  id: string;
  kind: PlanKind;
  owner_account_id: string | null;
  name: string;
  monthly_allowance: string;
  max_per_request: string;
  created_at: string;
}

export interface PlanInput {
  kind: PlanKind;
  name: string;
  monthlyAllowance: number;
  maxPerRequest: number;
}

export interface PlanUpdate {
  name?: string;
  monthlyAllowance?: number;
  maxPerRequest?: number;
}

const PLAN_SELECT = `
  id, kind, owner_account_id, name, monthly_allowance, max_per_request,
  to_char(created_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
`;

export async function listPlans(
  pool: Pool,
  accountId: string,
  kind?: PlanKind,
): Promise<PlanRecord[]> {
  const result = await pool.query<PlanRecord>(
    `SELECT ${PLAN_SELECT}
     FROM plans
     WHERE (owner_account_id IS NULL OR owner_account_id = $1)
       AND ($2::text IS NULL OR kind = $2)
     ORDER BY kind ASC, owner_account_id NULLS FIRST, name ASC, id ASC`,
    [accountId, kind ?? null],
  );
  return result.rows;
}

export async function findPlan(
  pool: Pool,
  accountId: string,
  planId: string,
): Promise<PlanRecord | undefined> {
  const result = await pool.query<PlanRecord>(
    `SELECT ${PLAN_SELECT}
     FROM plans
     WHERE id = $1
       AND (owner_account_id IS NULL OR owner_account_id = $2)`,
    [planId, accountId],
  );
  return result.rows[0];
}

export async function insertPlan(
  pool: Pool,
  accountId: string,
  input: PlanInput,
): Promise<PlanRecord | undefined> {
  const result = await pool.query<PlanRecord>(
    `INSERT INTO plans (
       kind, owner_account_id, name, monthly_allowance, max_per_request
     )
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, kind, owner_account_id, name, monthly_allowance, max_per_request,
               to_char(created_at AT TIME ZONE 'UTC',
                       'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at`,
    [input.kind, accountId, input.name, input.monthlyAllowance, input.maxPerRequest],
  );
  return result.rows[0];
}

export async function updatePlan(
  pool: PoolClient,
  accountId: string,
  planId: string,
  update: PlanUpdate,
): Promise<PlanRecord | undefined> {
  const result = await pool.query<PlanRecord>(
    `UPDATE plans
     SET name = COALESCE($3, name),
         monthly_allowance = COALESCE($4, monthly_allowance),
         max_per_request = COALESCE($5, max_per_request)
     WHERE id = $1
       AND owner_account_id = $2
     RETURNING id, kind, owner_account_id, name, monthly_allowance, max_per_request,
               to_char(created_at AT TIME ZONE 'UTC',
                       'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at`,
    [
      planId,
      accountId,
      update.name ?? null,
      update.monthlyAllowance ?? null,
      update.maxPerRequest ?? null,
    ],
  );
  return result.rows[0];
}

export async function assignAccountPlan(
  pool: PoolClient,
  accountId: string,
  planId: string,
): Promise<PlanRecord | undefined> {
  const result = await pool.query<PlanRecord>(
    `UPDATE accounts AS a
     SET plan_id = p.id
     FROM plans AS p
     WHERE a.id = $1
       AND p.id = $2
       AND p.kind = 'account'
       AND (p.owner_account_id IS NULL OR p.owner_account_id = a.id)
     RETURNING p.id, p.kind, p.owner_account_id, p.name,
               p.monthly_allowance, p.max_per_request,
               to_char(p.created_at AT TIME ZONE 'UTC',
                       'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at`,
    [accountId, planId],
  );
  return result.rows[0];
}

export async function assignUserPlan(
  pool: PoolClient,
  accountId: string,
  externalId: string,
  planId: string,
): Promise<PlanRecord | undefined> {
  const result = await pool.query<PlanRecord>(
    `UPDATE users AS u
     SET plan_id = p.id
     FROM plans AS p
     WHERE u.account_id = $1
       AND u.external_id = $2
       AND p.id = $3
       AND p.kind = 'user'
       AND (p.owner_account_id IS NULL OR p.owner_account_id = u.account_id)
     RETURNING p.id, p.kind, p.owner_account_id, p.name,
               p.monthly_allowance, p.max_per_request,
               to_char(p.created_at AT TIME ZONE 'UTC',
                       'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at`,
    [accountId, externalId, planId],
  );
  return result.rows[0];
}