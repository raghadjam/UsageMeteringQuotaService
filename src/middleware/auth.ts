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

export interface AccountIdCache {
  get(apiKeyHash: string): string | undefined;
  set(apiKeyHash: string, accountId: string): void;
}

const ACCOUNT_ID_CACHE_TTL_MS = 30_000;
const ACCOUNT_ID_CACHE_MAX_ENTRIES = 10_000;

export function createAccountIdCache(): AccountIdCache {
  const entries = new Map<string, { accountId: string; expiresAt: number }>();

  return {
    get(apiKeyHash) {
      const entry = entries.get(apiKeyHash);
      if (!entry) {
        return undefined;
      }
      if (entry.expiresAt <= Date.now()) {
        entries.delete(apiKeyHash);
        return undefined;
      }

      entries.delete(apiKeyHash);
      entries.set(apiKeyHash, entry);
      return entry.accountId;
    },
    set(apiKeyHash, accountId) {
      entries.delete(apiKeyHash);
      if (entries.size >= ACCOUNT_ID_CACHE_MAX_ENTRIES) {
        const oldestKey = entries.keys().next().value;
        if (oldestKey !== undefined) {
          entries.delete(oldestKey);
        }
      }
      entries.set(apiKeyHash, {
        accountId,
        expiresAt: Date.now() + ACCOUNT_ID_CACHE_TTL_MS,
      });
    },
  };
}

declare global {
  namespace Express {
    interface Locals {
      account: Pick<AuthenticatedAccount, "id">;
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

export function requireAccountApiKey(
  pool: Pool,
  cache: AccountIdCache | null = createAccountIdCache(),
): RequestHandler {
  return async (req, res, next) => {
    const apiKey = req.get("X-API-Key");
    if (!apiKey) {
      res.status(401).json({
        error: { code: "invalid_api_key", message: "Missing or invalid API key" },
      });
      return;
    }

    try {
      const apiKeyHash = hashApiKey(apiKey);
      let accountId = cache?.get(apiKeyHash);
      if (!accountId) {
        const result = await pool.query<{ id: string }>(
          `SELECT id
           FROM accounts
           WHERE api_key_hash = $1`,
          [apiKeyHash],
        );

        accountId = result.rows[0]?.id;
        if (!accountId) {
          res.status(401).json({
            error: { code: "invalid_api_key", message: "Missing or invalid API key" },
          });
          return;
        }
        cache?.set(apiKeyHash, accountId);
      }

      res.locals.account = { id: accountId };
      next();
    } catch (error) {
      next(error);
    }
  };
}