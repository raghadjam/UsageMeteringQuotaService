import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { hashApiKey, type AuthenticatedAccount } from "../middleware/auth";
import { getAccountProfile, insertAccount } from "../db/queries/accounts";
import { AppError } from "../errors";

export interface CreatedAccount extends AuthenticatedAccount {
  apiKey: string;
}

export async function createAccount(
  pool: Pool,
  name: string,
): Promise<CreatedAccount> {
  const apiKey = randomBytes(32).toString("base64url");
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const inserted = await insertAccount(client, name, hashApiKey(apiKey));
    if (!inserted) {
      throw new AppError(
        500,
        "default_plan_missing",
        "The predefined Starter account plan is missing",
      );
    }

    await client.query("COMMIT");
    return {
      id: inserted.id,
      name: inserted.name,
      apiKey,
      plan: {
        id: inserted.plan_id,
        name: inserted.plan_name,
        monthlyAllowance: Number(inserted.monthly_allowance),
        maxPerRequest: Number(inserted.max_per_request),
      },
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getAccount(
  pool: Pool,
  accountId: string,
): Promise<AuthenticatedAccount> {
  const account = await getAccountProfile(pool, accountId);
  if (!account) {
    throw new AppError(401, "invalid_api_key", "Missing or invalid API key");
  }

  return {
    id: account.id,
    name: account.name,
    plan: {
      id: account.plan_id,
      name: account.plan_name,
      monthlyAllowance: Number(account.monthly_allowance),
      maxPerRequest: Number(account.max_per_request),
    },
  };
}