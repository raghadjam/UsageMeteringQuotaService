import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config";

const validEnvironment = {
  DATABASE_URL: "postgresql://user:password@localhost:5432/usage_metering",
  ADMIN_API_KEY: "a".repeat(32),
};

test("locking consumption strategy is the default", () => {
  const config = loadConfig(validEnvironment);
  assert.equal(config.consumptionStrategy, "locking");
  assert.equal(config.databasePoolMax, 50);
  assert.equal(config.apiKeyCacheEnabled, true);
  assert.equal(config.consumeLockTimeoutMs, 5_000);
  assert.equal(config.consumeStatementTimeoutMs, 15_000);
});

test("consume timeouts are configurable and validated", () => {
  const config = loadConfig({
    ...validEnvironment,
    CONSUME_LOCK_TIMEOUT_MS: "3000",
    CONSUME_STATEMENT_TIMEOUT_MS: "10000",
  });
  assert.equal(config.consumeLockTimeoutMs, 3_000);
  assert.equal(config.consumeStatementTimeoutMs, 10_000);

  for (const value of ["0", "60001", "3.5", "invalid"]) {
    assert.throws(
      () => loadConfig({
        ...validEnvironment,
        CONSUME_LOCK_TIMEOUT_MS: value,
      }),
      /CONSUME_LOCK_TIMEOUT_MS must be an integer between 1 and 60000/,
    );
  }
  for (const value of ["0", "120001", "3.5", "invalid"]) {
    assert.throws(
      () => loadConfig({
        ...validEnvironment,
        CONSUME_STATEMENT_TIMEOUT_MS: value,
      }),
      /CONSUME_STATEMENT_TIMEOUT_MS must be an integer between 1 and 120000/,
    );
  }
});

test("API key account cache can be disabled and rejects invalid values", () => {
  const config = loadConfig({
    ...validEnvironment,
    API_KEY_CACHE_ENABLED: "false",
  });
  assert.equal(config.apiKeyCacheEnabled, false);

  assert.throws(
    () => loadConfig({
      ...validEnvironment,
      API_KEY_CACHE_ENABLED: "yes",
    }),
    /API_KEY_CACHE_ENABLED must be true or false/,
  );
});

test("conditional consumption strategy can be selected", () => {
  const config = loadConfig({
    ...validEnvironment,
    CONSUMPTION_STRATEGY: "conditional",
  });
  assert.equal(config.consumptionStrategy, "conditional");
});

test("unknown consumption strategies fail configuration", () => {
  assert.throws(
    () => loadConfig({
      ...validEnvironment,
      CONSUMPTION_STRATEGY: "unknown",
    }),
    /CONSUMPTION_STRATEGY must be locking or conditional/,
  );
});

test("database pool size can be configured and invalid sizes are rejected", () => {
  const config = loadConfig({
    ...validEnvironment,
    DB_POOL_MAX: "75",
  });
  assert.equal(config.databasePoolMax, 75);

  for (const value of ["0", "101", "not-a-number"]) {
    assert.throws(
      () => loadConfig({ ...validEnvironment, DB_POOL_MAX: value }),
      /DB_POOL_MAX must be an integer between 1 and 100/,
    );
  }
});
