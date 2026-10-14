import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { hashApiKey, type AuthenticatedAccount } from "../middleware/auth";
import { insertAccount } from "../db/queries/accounts";
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