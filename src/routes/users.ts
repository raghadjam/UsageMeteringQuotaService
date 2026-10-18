import { Router } from "express";
import { z } from "zod";
import type { Pool } from "pg";
import { AppError } from "../errors";
import { requireAccountApiKey } from "../middleware/auth";
import type { AccountIdCache } from "../middleware/auth";
import { validateBody } from "../middleware/validate";
import { createUser, getUser, getUsers } from "../services/userService";

const createUserSchema = z.object({
  external_id: z.string().trim().min(1).max(120),
  plan_id: z.string().uuid().optional(),
}).strict();

const listUsersSchema = z.object({
  limit: z.string().regex(/^\d+$/).transform(Number)
    .pipe(z.number().int().min(1).max(200))
    .optional(),
  cursor: z.string().min(1).max(512).optional(),
}).strict();

const cursorSchema = z.object({
  created_at: z.string().datetime({ offset: true }),
  id: z.string().uuid(),
}).strict();

function serializeUser(user: {
  id: string;
  external_id: string;
  plan_id: string;
  plan_name: string;
  monthly_allowance: string;
  max_per_request: string;
  created_at: string;
}) {
  return {
    id: user.id,
    external_id: user.external_id,
    plan: {
      id: user.plan_id,
      name: user.plan_name,
      monthly_allowance: Number(user.monthly_allowance),
      max_per_request: Number(user.max_per_request),
    },
    created_at: user.created_at,
  };
}

function decodeCursor(encoded: string | undefined):
  | { createdAt: string; id: string }
  | undefined {
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

export function createUsersRouter(
  pool: Pool,
  accountIdCache: AccountIdCache | null,
): Router {
  const router = Router();
  const authenticate = requireAccountApiKey(pool, accountIdCache);

  router.post(
    "/users",
    authenticate,
    validateBody(createUserSchema),
    async (req, res) => {
      const user = await createUser(
        pool,
        res.locals.account.id,
        req.body.external_id,
        req.body.plan_id,
      );
      res.status(201).json({ user: serializeUser(user) });
    },
  );

  router.get("/users", authenticate, async (req, res) => {
    const parsedQuery = listUsersSchema.safeParse(req.query);
    if (!parsedQuery.success) {
      throw new AppError(400, "invalid_query", "User list query is invalid");
    }

    const limit = parsedQuery.data.limit ?? 50;
    const cursor = decodeCursor(parsedQuery.data.cursor);
    const result = await getUsers(pool, res.locals.account.id, limit, cursor);
    const lastUser = result.users[result.users.length - 1];
    const nextCursor =
      result.hasMore && lastUser
        ? encodeCursor({ createdAt: lastUser.created_at, id: lastUser.id })
        : null;

    res.json({
      users: result.users.map(serializeUser),
      next_cursor: nextCursor,
    });
  });

  router.get("/users/:externalId", authenticate, async (req, res) => {
    const parsedExternalId = z.string().min(1).max(120).safeParse(req.params.externalId);
    if (!parsedExternalId.success) {
      throw new AppError(400, "invalid_external_id", "User identifier is invalid");
    }

    const user = await getUser(
      pool,
      res.locals.account.id,
      parsedExternalId.data,
    );
    res.json({ user: serializeUser(user) });
  });

  return router;
}