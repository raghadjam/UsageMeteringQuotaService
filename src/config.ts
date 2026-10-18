export interface AppConfig {
  databaseUrl: string;
  adminApiKey: string;
  port: number;
  databasePoolMax: number;
  consumeLockTimeoutMs: number;
  consumeStatementTimeoutMs: number;
  consumptionStrategy: "locking" | "conditional";
  apiKeyCacheEnabled: boolean;
}

function positiveInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  defaultValue: string,
  max: number,
): number {
  const value = env[name] ?? defaultValue;
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be an integer between 1 and ${max}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}`);
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL must be set");
  }

  const adminApiKey = env.ADMIN_API_KEY;
  if (!adminApiKey || adminApiKey.length < 32) {
    throw new Error("ADMIN_API_KEY must contain at least 32 characters");
  }

  const portValue = env.PORT ?? "3000";
  if (!/^\d+$/.test(portValue)) {
    throw new Error("PORT must be a valid integer between 1 and 65535");
  }

  const port = Number(portValue);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be a valid integer between 1 and 65535");
  }

  const databasePoolMaxValue = env.DB_POOL_MAX ?? "50";
  if (!/^\d+$/.test(databasePoolMaxValue)) {
    throw new Error("DB_POOL_MAX must be an integer between 1 and 100");
  }
  const databasePoolMax = Number(databasePoolMaxValue);
  if (!Number.isSafeInteger(databasePoolMax) || databasePoolMax < 1 || databasePoolMax > 100) {
    throw new Error("DB_POOL_MAX must be an integer between 1 and 100");
  }

  const consumeLockTimeoutMs = positiveInteger(
    env,
    "CONSUME_LOCK_TIMEOUT_MS",
    "1000",
    60_000,
  );
  const consumeStatementTimeoutMs = positiveInteger(
    env,
    "CONSUME_STATEMENT_TIMEOUT_MS",
    "30000",
    120_000,
  );

  const consumptionStrategy = env.CONSUMPTION_STRATEGY ?? "locking";
  if (consumptionStrategy !== "locking" && consumptionStrategy !== "conditional") {
    throw new Error("CONSUMPTION_STRATEGY must be locking or conditional");
  }

  const apiKeyCacheEnabledValue = env.API_KEY_CACHE_ENABLED ?? "true";
  if (apiKeyCacheEnabledValue !== "true" && apiKeyCacheEnabledValue !== "false") {
    throw new Error("API_KEY_CACHE_ENABLED must be true or false");
  }

  return {
    databaseUrl,
    adminApiKey,
    port,
    databasePoolMax,
    consumeLockTimeoutMs,
    consumeStatementTimeoutMs,
    consumptionStrategy,
    apiKeyCacheEnabled: apiKeyCacheEnabledValue === "true",
  };
}