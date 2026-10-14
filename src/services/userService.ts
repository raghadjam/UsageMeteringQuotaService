import type { Pool } from "pg";
import {
  findUser,
  insertUser,
  listUsers,
  type UserCursor,
  type UserRecord,
} from "../db/queries/users";
import { AppError } from "../errors";

function isUniqueViolation(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "23505"
  );
}

export async function createUser(
  pool: Pool,
  accountId: string,
  externalId: string,
  planId?: string,
): Promise<UserRecord> {
  try {
    const user = await insertUser(pool, accountId, externalId, planId);
    if (!user) {
      if (planId) {
        throw new AppError(404, "plan_not_found", "User plan not found");
      }
      throw new AppError(
        500,
        "default_plan_missing",
        "The predefined Basic user plan is missing",
      );
    }
    return user;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new AppError(409, "user_already_exists", "User already exists in this account");
    }
    throw error;
  }
}

export async function getUser(
  pool: Pool,
  accountId: string,
  externalId: string,
): Promise<UserRecord> {
  const user = await findUser(pool, accountId, externalId);
  if (!user) {
    throw new AppError(404, "user_not_found", "User not found");
  }
  return user;
}

export async function getUsers(
  pool: Pool,
  accountId: string,
  limit: number,
  cursor?: UserCursor,
): Promise<{ users: UserRecord[]; hasMore: boolean }> {
  const rows = await listUsers(pool, accountId, limit + 1, cursor);
  return { users: rows.slice(0, limit), hasMore: rows.length > limit };
}