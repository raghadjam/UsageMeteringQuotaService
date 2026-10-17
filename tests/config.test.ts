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
