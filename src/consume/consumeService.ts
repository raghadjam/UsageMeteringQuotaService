import type { Pool } from "pg";
import { AppError } from "../errors";
import {
  claimRequest,
  completeRequest,
  findRequest,
} from "../db/queries/requests";
import { isConsumptionDecision, type ConsumptionDecision } from "./rules";
import { lockingStrategy } from "./lockingStrategy";
import type { ConsumptionStrategy } from "./strategy";

interface ConsumptionUser {
  month: string;
  account_plan_id: string;
  account_plan_name: string;
  account_monthly_allowance: string;
  account_max_per_request: string;
  user_id: string | null;
  external_id: string | null;
  user_plan_id: string | null;
  user_plan_name: string | null;
  user_monthly_allowance: string | null;
  user_max_per_request: string | null;
}

type ResolvedConsumptionUser = ConsumptionUser & {
  user_id: string;
  external_id: string;
  user_plan_id: string;
  user_plan_name: string;
  user_monthly_allowance: string;
  user_max_per_request: string;
};

function hasUser(
  row: ConsumptionUser,
): row is ResolvedConsumptionUser {
  return (
    row.user_id !== null &&
    row.external_id !== null &&
    row.user_plan_id !== null &&
    row.user_plan_name !== null &&
    row.user_monthly_allowance !== null &&
    row.user_max_per_request !== null
  );
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

    const userResult = await client.query<ConsumptionUser>(
      `SELECT date_trunc(
                'month',
                transaction_timestamp() AT TIME ZONE 'UTC'
              )::date::text AS month,
              a.plan_id AS account_plan_id, ap.name AS account_plan_name,
              ap.monthly_allowance::text AS account_monthly_allowance,
              ap.max_per_request::text AS account_max_per_request,
              u.id AS user_id, u.external_id, u.plan_id AS user_plan_id,
              up.name AS user_plan_name,
              up.monthly_allowance::text AS user_monthly_allowance,
              up.max_per_request::text AS user_max_per_request
       FROM accounts a
       JOIN plans ap ON ap.id = a.plan_id
       LEFT JOIN users u
         ON u.account_id = a.id AND u.external_id = $2
       LEFT JOIN plans up ON up.id = u.plan_id
       WHERE a.id = $1
       -- Plan mutations lock the account before touching plans or users.
       -- Lock only that row here to preserve their order and avoid an
       -- unordered account/user lock in this joined SELECT.
       FOR SHARE OF a`,
      [input.accountId, input.userExternalId],
    );
    const accountUser = userResult.rows[0];
    if (!accountUser) {
      throw new AppError(401, "invalid_api_key", "Missing or invalid API key");
    }
    if (!hasUser(accountUser)) {
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
    const user = accountUser;
    const month = user.month;

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