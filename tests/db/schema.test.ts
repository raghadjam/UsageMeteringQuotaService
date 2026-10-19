import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { connectionString, registerDbHooks, requireSeed, requireTestPool } from "./helpers";

registerDbHooks();

test("migrations initialize schema and can be applied repeatedly", {
  skip: !connectionString,
}, async () => {
  const result = await requireTestPool().query<{ name: string }>(
    "SELECT name FROM schema_migrations ORDER BY name",
  );
  assert.deepEqual(result.rows.map((row) => row.name), [
    "001_initial_schema.sql",
    "002_users_list_index.sql",
  ]);
});

test("plan-kind relationships are constrained", {
  skip: !connectionString,
}, async () => {
  const pool = requireTestPool();
  const { starterPlanId, basicPlanId, accountId } = requireSeed();

  await assert.rejects(
    pool.query(
      `INSERT INTO accounts (name, api_key_hash, plan_id)
       VALUES ('Wrong plan kind', $1, $2)`,
      ["b".repeat(64), basicPlanId],
    ),
    { code: "23503" },
  );

  await assert.rejects(
    pool.query(
      `INSERT INTO users (account_id, external_id, plan_id)
       VALUES ($1, 'wrong-plan-kind', $2)`,
      [accountId, starterPlanId],
    ),
    { code: "23503" },
  );
});

test("usage and request constraints preserve monthly accounting invariants", {
  skip: !connectionString,
}, async () => {
  const pool = requireTestPool();
  const { accountId, userId } = requireSeed();

  await pool.query(
    "INSERT INTO user_usage (user_id, month, units_used) VALUES ($1, '2026-10-01', 0)",
    [userId],
  );

  await assert.rejects(
    pool.query(
      "INSERT INTO user_usage (user_id, month, units_used) VALUES ($1, '2026-10-02', 0)",
      [userId],
    ),
    { code: "23514" },
  );

  await assert.rejects(
    pool.query(
      `INSERT INTO plans (kind, owner_account_id, name, monthly_allowance, max_per_request)
       VALUES ('user', $1, 'unsafe-limit', 9007199254740992, 1)`,
      [accountId],
    ),
    { code: "23514" },
  );

  await assert.rejects(
    pool.query(
      `INSERT INTO requests (account_id, request_id, user_id, units, month)
       VALUES ($1, 'bad-request', $2, 0, '2026-10-01')`,
      [accountId, userId],
    ),
    { code: "23514" },
  );

  await assert.rejects(
    pool.query(
      `INSERT INTO requests (account_id, request_id, user_id, units, month)
       VALUES ($1, 'wrong-account', $2, 1, '2026-10-01')`,
      [randomUUID(), userId],
    ),
    { code: "23503" },
  );
});
