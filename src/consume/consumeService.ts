import type { Pool } from "pg";
import { AppError } from "../errors";
import {
  claimRequest,
  completeRequest,
  findRequest,
} from "../db/queries/requests";
import {
  ensureUsageRows,
} from "../db/queries/usage";
import { isConsumptionDecision, type ConsumptionDecision } from "./rules";
import { lockingStrategy } from "./lockingStrategy";
import type { ConsumptionStrategy } from "./strategy";

interface ConsumptionUser {
  account_plan_id: string;
  account_plan_name: string;
  account_monthly_allowance: string;
  account_max_per_request: string;
  user_id: string;
  external_id: string;
  user_plan_id: string;
  user_plan_name: string;
  user_monthly_allowance: string;
  user_max_per_request: string;
}

export interface ConsumeInput {
  accountId: string;
  userExternalId: string;
  units: number;
  requestId: string;
}

export interface ConsumeResult extends ConsumptionDecision {
  request_id: string;
  replayed: boolean;
}

function asSafeNumber(value: string, name: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`Database returned an invalid ${name}`);
  }
  return number;
}

function serializeDecision(
  requestId: string,
  decision: ConsumptionDecision,
  replayed: boolean,
): ConsumeResult {
  return { request_id: requestId, replayed, ...decision };
}

export async function consume(
  pool: Pool,
  input: ConsumeInput,
  strategy: ConsumptionStrategy = lockingStrategy,
): Promise<ConsumeResult> {
  const client = await pool.connect();
  let inTransaction = false;

  try {
    await client.query("BEGIN");
    inTransaction = true;

    const monthResult = await client.query<{ month: string }>(
      `SELECT date_trunc(
                'month',
                transaction_timestamp() AT TIME ZONE 'UTC'
              )::date::text AS month`,
    );
    const month = monthResult.rows[0]?.month;
    if (!month) {
      throw new Error("Could not determine current UTC month");
    }

    const accountResult = await client.query(
      "SELECT id FROM accounts WHERE id = $1 FOR SHARE",
      [input.accountId],
    );
    if (accountResult.rowCount !== 1) {
      throw new AppError(401, "invalid_api_key", "Missing or invalid API key");
    }

    const userResult = await client.query<ConsumptionUser>(
      `SELECT a.plan_id AS account_plan_id, ap.name AS account_plan_name,
              ap.monthly_allowance::text AS account_monthly_allowance,
              ap.max_per_request::text AS account_max_per_request,
              u.id AS user_id, u.external_id, u.plan_id AS user_plan_id,
              up.name AS user_plan_name,
              up.monthly_allowance::text AS user_monthly_allowance,
              up.max_per_request::text AS user_max_per_request
       FROM users u
       JOIN accounts a ON a.id = u.account_id
       JOIN plans ap ON ap.id = a.plan_id
       JOIN plans up ON up.id = u.plan_id
       WHERE a.id = $1 AND u.external_id = $2
       FOR SHARE OF u`,
      [input.accountId, input.userExternalId],
    );
    const user = userResult.rows[0];
    if (!user) {
      const existing = await findRequest(client, input.accountId, input.requestId);
      if (existing) {
        throw new AppError(
          409,
          "request_id_conflict",
          "Request ID was already used with different input",
        );
      }
      throw new AppError(404, "user_not_found", "User not found in this account");
    }

    const claimed = await claimRequest(
      client,
      input.accountId,
      input.requestId,
      user.user_id,
      input.units,
      month,
    );
    if (!claimed) {
      const existing = await findRequest(client, input.accountId, input.requestId);
      if (!existing) {
        throw new Error("Conflicting request ID disappeared");
      }
      if (
        existing.user_external_id !== input.userExternalId ||
        asSafeNumber(existing.units, "request units") !== input.units
      ) {
        throw new AppError(
          409,
          "request_id_conflict",
          "Request ID was already used with different input",
        );
      }
      if (!isConsumptionDecision(existing.decision)) {
        throw new Error("Committed request does not contain its decision");
      }
      await client.query("COMMIT");
      inTransaction = false;
      return serializeDecision(
        input.requestId,
        existing.decision as ConsumptionDecision,
        true,
      );
    }

    await ensureUsageRows(client, input.accountId, user.user_id, month);
    const decision = await strategy({
      client,
      accountId: input.accountId,
      userId: user.user_id,
      month,
      units: input.units,
      accountPlan: {
        id: user.account_plan_id,
        name: user.account_plan_name,
        monthly_allowance: asSafeNumber(
          user.account_monthly_allowance,
          "account monthly allowance",
        ),
        max_per_request: asSafeNumber(
          user.account_max_per_request,
          "account max per request",
        ),
      },
      userPlan: {
        id: user.user_plan_id,
        name: user.user_plan_name,
        monthly_allowance: asSafeNumber(
          user.user_monthly_allowance,
          "user monthly allowance",
        ),
        max_per_request: asSafeNumber(
          user.user_max_per_request,
          "user max per request",
        ),
      },
    });

    const completed = await completeRequest(
      client,
      input.accountId,
      input.requestId,
      decision,
      decision.rejected_by,
    );
    if (!completed) {
      throw new Error("Claimed request could not be completed");
    }
    await client.query("COMMIT");
    inTransaction = false;
    return serializeDecision(input.requestId, decision, false);
  } catch (error) {
    if (inTransaction) {
      await client.query("ROLLBACK");
    }
    throw error;
  } finally {
    client.release();
  }
}