import { Router } from "express";
import { z } from "zod";
import type { Pool } from "pg";
import { AppError } from "../errors";
import { requireAccountApiKey } from "../middleware/auth";
import { getRequestHistory, parseMonth } from "../services/requestService";

const querySchema = z.object({
  user_id: z.string().trim().min(1).max(120).optional(),
  month: z.string().optional(),
  outcome: z.enum(["accepted", "rejected"]).optional(),
  limit: z.string().regex(/^\d+$/).transform(Number)
    .pipe(z.number().int().min(1).max(200))
    .optional(),
  cursor: z.string().min(1).max(512).optional(),
}).strict();

const cursorSchema = z.object({
  created_at: z.string().datetime({ offset: true }),
  id: z.string().uuid(),
}).strict();

function decodeCursor(encoded: string | undefined) {
  if (!encoded) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new AppError(400, "invalid_cursor", "Pagination cursor is invalid");
  }
  const result = cursorSchema.safeParse(parsed);
  if (!result.success) {
    throw new AppError(400, "invalid_cursor", "Pagination cursor is invalid");
  }
  return { createdAt: result.data.created_at, id: result.data.id };
}

function encodeCursor(cursor: { createdAt: string; id: string }): string {
  return Buffer.from(
    JSON.stringify({ created_at: cursor.createdAt, id: cursor.id }),
  ).toString("base64url");
}

export function createRequestsRouter(pool: Pool): Router {
  const router = Router();

  router.get("/requests", requireAccountApiKey(pool), async (req, res) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new AppError(400, "invalid_query", "Request history query is invalid");
    }
    const cursor = decodeCursor(parsed.data.cursor);
    const result = await getRequestHistory(pool, {
      accountId: res.locals.account.id,
      userExternalId: parsed.data.user_id,
      month: parseMonth(parsed.data.month),
      outcome: parsed.data.outcome,
      limit: parsed.data.limit ?? 50,
      cursor,
    });
    res.json({
      requests: result.requests.map((record) => ({
        request_id: record.request_id,
        user_id: record.user_id,
        units: Number(record.units),
        month: record.month,
        outcome: record.outcome,
        rejected_by: record.rejected_level
          ? { level: record.rejected_level, rule: record.rejected_rule }
          : null,
        decision: record.decision,
        created_at: record.created_at,
      })),
      next_cursor: result.nextCursor ? encodeCursor(result.nextCursor) : null,
    });
  });

  return router;
}