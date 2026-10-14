import type { PoolClient } from "pg";

export interface AccountInsert {
  id: string;
  name: string;
  plan_id: string;
  plan_name: string;
  monthly_allowance: string;
  max_per_request: string;
}

export async function insertAccount(
  client: PoolClient,
  name: string,
  apiKeyHash: string,
): Promise<AccountInsert | undefined> {
  const result = await client.query<AccountInsert>(
    `WITH inserted AS (
       INSERT INTO accounts (name, api_key_hash, plan_id)
       SELECT $1, $2, p.id
       FROM plans p
       WHERE p.kind = 'account'
         AND p.owner_account_id IS NULL
         AND p.name = 'Starter'
       RETURNING id, name, plan_id
     )
     SELECT i.id, i.name, i.plan_id, p.name AS plan_name,
            p.monthly_allowance, p.max_per_request
     FROM inserted i
     JOIN plans p ON p.id = i.plan_id`,
    [name, apiKeyHash],
  );
  return result.rows[0];
}