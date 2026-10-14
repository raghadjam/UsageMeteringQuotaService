export interface AppConfig {
  databaseUrl: string;
  adminApiKey: string;
  port: number;
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

  return { databaseUrl, adminApiKey, port };
}