import type { Pool } from "pg";
import {
  listRequestHistory,
  type RequestHistoryFilters,
} from "../db/queries/requests";
import { AppError } from "../errors";
import { getUser } from "./userService";

export async function getRequestHistory(
  pool: Pool,
  filters: RequestHistoryFilters,
) {
  if (filters.userExternalId) {
    await getUser(pool, filters.accountId, filters.userExternalId);
  }
  const rows = await listRequestHistory(pool, {
    ...filters,
    limit: filters.limit + 1,
  });
  const hasMore = rows.length > filters.limit;
  const requests = rows.slice(0, filters.limit);
  for (const record of requests) {
    if (!record.decision || typeof record.decision !== "object") {
      throw new Error("Committed request does not contain its decision");
    }
  }
  const lastRequest = requests[requests.length - 1];
  return {
    requests,
    nextCursor:
      hasMore && lastRequest
        ? { createdAt: lastRequest.created_at, id: lastRequest.id }
        : null,
  };
}

export function parseMonth(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!/^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(value)) {
    throw new AppError(400, "invalid_month", "Month must use YYYY-MM format");
  }
  return value;
}
