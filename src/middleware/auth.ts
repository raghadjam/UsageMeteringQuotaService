import { createHash, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import type { Pool } from "pg";

export interface AuthenticatedAccount {
  id: string;
  name: string;
  plan: {
    id: string;
    name: string;
    monthlyAllowance: number;
    maxPerRequest: number;
  };
}

declare global {
  namespace Express {
    interface Locals {
      account: AuthenticatedAccount;
    }
  }
}

export function hashApiKey(apiKey: string): string {
  return createHash("sha256").update(apiKey, "utf8").digest("hex");
}

export function requireAdminApiKey(adminApiKey: string): RequestHandler {
  const expectedHash = createHash("sha256").update(adminApiKey, "utf8").digest();

  return (req, res, next) => {
    const suppliedKey = req.get("X-Admin-API-Key");
    const suppliedHash = createHash("sha256")
      .update(suppliedKey ?? "", "utf8")
      .digest();
    const valid =
      suppliedKey !== undefined && timingSafeEqual(suppliedHash, expectedHash);

    if (!valid) {
      res.status(401).json({
        error: { code: "invalid_admin_api_key", message: "Invalid admin API key" },
      });
      return;
    }

    next();
  };
}

export function requireAccountApiKey(pool: Pool): RequestHandler {
  return async (req, res, next) => {
    const apiKey = req.get("X-API-Key");
    if (!apiKey) {
      res.status(401).json({
        error: { code: "invalid_api_key", message: "Missing or invalid API key" },
      });
      return;
    }

    try {
      const result = await pool.query<{
        id: string;
        name: string;
        plan_id: string;
        plan_name: string;
        monthly_allowance: string;
        max_per_request: string;
      }>(
        `SELECT a.id, a.name, p.id AS plan_id, p.name AS plan_name,
                p.monthly_allowance, p.max_per_request
         FROM accounts a
         JOIN plans p ON p.id = a.plan_id
         WHERE a.api_key_hash = $1`,
        [hashApiKey(apiKey)],
      );

      const account = result.rows[0];
      if (!account) {
        res.status(401).json({
          error: { code: "invalid_api_key", message: "Missing or invalid API key" },
        });
        return;
      }

      res.locals.account = {
        id: account.id,
        name: account.name,
        plan: {
          id: account.plan_id,
          name: account.plan_name,
          monthlyAllowance: Number(account.monthly_allowance),
          maxPerRequest: Number(account.max_per_request),
        },
      };
      next();
    } catch (error) {
      next(error);
    }
  };
}