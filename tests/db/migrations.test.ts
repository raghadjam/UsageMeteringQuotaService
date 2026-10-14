import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import request from "supertest";
import { createApp } from "../../src/app";
import { hashApiKey } from "../../src/middleware/auth";
import { runMigrations } from "../../src/db/migrate";

const connectionString = process.env.TEST_DATABASE_URL;
const migrationDirectory = path.join(__dirname, "../../src/db/migrations");

let adminPool: Pool | undefined;
let testPool: Pool | undefined;
let schemaName: string | undefined;
let seed: {
  starterPlanId: string;
  basicPlanId: string;
  accountId: string;
  userId: string;
} | undefined;

function requireTestPool(): Pool {
  if (!testPool) {
    throw new Error("The database test schema was not initialized");
  }
  return testPool;
}

function requireSeed(): NonNullable<typeof seed> {
  if (!seed) {
    throw new Error("The database test fixtures were not initialized");
  }
  return seed;
}

if (connectionString) {
  before(async () => {
    adminPool = new Pool({ connectionString });
    schemaName = `migration_test_${randomUUID().replaceAll("-", "")}`;
    await adminPool.query(`CREATE SCHEMA "${schemaName}"`);

    testPool = new Pool({
      connectionString,
      options: `-c search_path=${schemaName}`,
    });

    await runMigrations(testPool, migrationDirectory);
    await runMigrations(testPool, migrationDirectory);

    const plans = await testPool.query<{ id: string; kind: string; name: string }>(
      "SELECT id, kind, name FROM plans ORDER BY name",
    );
    assert.deepEqual(
      plans.rows.map(({ kind, name }) => `${kind}:${name}`).sort(),
      ["account:Pro", "account:Starter", "user:Basic", "user:Premium"],
    );

    const starterPlanId = plans.rows.find((plan) => plan.name === "Starter")?.id;
    const basicPlanId = plans.rows.find((plan) => plan.name === "Basic")?.id;
    assert.ok(starterPlanId);
    assert.ok(basicPlanId);

    const account = await testPool.query<{ id: string }>(
      `INSERT INTO accounts (name, api_key_hash, plan_id)
       VALUES ('Test account', $1, $2)
       RETURNING id`,
      ["a".repeat(64), starterPlanId],
    );
    const accountId = account.rows[0].id;

    const user = await testPool.query<{ id: string }>(
      `INSERT INTO users (account_id, external_id, plan_id)
       VALUES ($1, 'test-user', $2)
       RETURNING id`,
      [accountId, basicPlanId],
    );
    seed = { starterPlanId, basicPlanId, accountId, userId: user.rows[0].id };
  });

  after(async () => {
    await testPool?.end();
    if (adminPool && schemaName) {
      await adminPool.query(`DROP SCHEMA "${schemaName}" CASCADE`);
      await adminPool.end();
    }
  });
}

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

test("account keys authenticate only as their own account", {
  skip: !connectionString,
}, async () => {
  const pool = requireTestPool();
  const { accountId, starterPlanId } = requireSeed();
  const otherKey = randomUUID() + randomUUID();
  const otherAccount = await pool.query<{ id: string }>(
    `INSERT INTO accounts (name, api_key_hash, plan_id)
     VALUES ('Other account', $1, $2)
     RETURNING id`,
    [hashApiKey(otherKey), starterPlanId],
  );
  const app = createApp({ pool, adminApiKey: "a".repeat(32) });

  const accountResponse = await request(app)
    .get("/v1/account")
    .set("X-API-Key", "a".repeat(32));
  assert.equal(accountResponse.status, 401);

  const firstApiKey = "a".repeat(32);
  await pool.query(
    "UPDATE accounts SET api_key_hash = $1 WHERE id = $2",
    [hashApiKey(firstApiKey), accountId],
  );

  const authenticated = await request(app)
    .get("/v1/account")
    .set("X-API-Key", firstApiKey);
  assert.equal(authenticated.status, 200);
  assert.equal(authenticated.body.id, accountId);

  const otherAuthenticated = await request(app)
    .get("/v1/account")
    .set("X-API-Key", otherKey);
  assert.equal(otherAuthenticated.status, 200);
  assert.equal(otherAuthenticated.body.id, otherAccount.rows[0].id);

  const missingKey = await request(app).get("/v1/account");
  assert.equal(missingKey.status, 401);
  const invalidKey = await request(app)
    .get("/v1/account")
    .set("X-API-Key", "invalid-key");
  assert.equal(invalidKey.status, 401);
  assert.deepEqual(missingKey.body, invalidKey.body);
});

test("admin can create accounts and receives a one-time API key", {
  skip: !connectionString,
}, async () => {
  const pool = requireTestPool();
  const app = createApp({ pool, adminApiKey: "admin-secret-key".padEnd(32, "!") });
  const payload = { name: "Created through API" };

  const unauthorized = await request(app).post("/v1/accounts").send(payload);
  assert.equal(unauthorized.status, 401);

  const invalid = await request(app)
    .post("/v1/accounts")
    .set("X-Admin-API-Key", "admin-secret-key".padEnd(32, "!"))
    .send({ name: " " });
  assert.equal(invalid.status, 400);

  const created = await request(app)
    .post("/v1/accounts")
    .set("X-Admin-API-Key", "admin-secret-key".padEnd(32, "!"))
    .send(payload);
  assert.equal(created.status, 201);
  assert.equal(created.body.name, payload.name);
  assert.equal(created.body.plan.name, "Starter");
  assert.equal(typeof created.body.api_key, "string");
  assert.ok(created.body.api_key.length >= 40);

  const saved = await pool.query<{ api_key_hash: string }>(
    "SELECT api_key_hash FROM accounts WHERE id = $1",
    [created.body.id],
  );
  assert.equal(saved.rows[0].api_key_hash, hashApiKey(created.body.api_key));
  assert.notEqual(saved.rows[0].api_key_hash, created.body.api_key);

  const authenticated = await request(app)
    .get("/v1/account")
    .set("X-API-Key", created.body.api_key);
  assert.equal(authenticated.status, 200);
  assert.equal(authenticated.body.id, created.body.id);
});

test("users are created, listed, and fetched only within their authenticated account", {
  skip: !connectionString,
}, async () => {
  const pool = requireTestPool();
  const { accountId, starterPlanId, basicPlanId } = requireSeed();
  const firstApiKey = randomUUID() + randomUUID();
  const secondApiKey = randomUUID() + randomUUID();

  await pool.query(
    "UPDATE accounts SET api_key_hash = $1 WHERE id = $2",
    [hashApiKey(firstApiKey), accountId],
  );
  const secondAccountResult = await pool.query<{ id: string }>(
    `INSERT INTO accounts (name, api_key_hash, plan_id)
     VALUES ('Second user-test account', $1, $2)
     RETURNING id`,
    [hashApiKey(secondApiKey), starterPlanId],
  );
  const secondAccountId = secondAccountResult.rows[0].id;
  const customPlanResult = await pool.query<{ id: string }>(
    `INSERT INTO plans (kind, owner_account_id, name, monthly_allowance, max_per_request)
     VALUES ('user', $1, 'User-test custom plan', 250, 30)
     RETURNING id`,
    [accountId],
  );
  const app = createApp({ pool, adminApiKey: "a".repeat(32) });

  const created = await request(app)
    .post("/v1/users")
    .set("X-API-Key", firstApiKey)
    .send({ external_id: "demo-user" });
  assert.equal(created.status, 201);
  assert.equal(created.body.user.external_id, "demo-user");
  assert.equal(created.body.user.plan.id, basicPlanId);
  assert.equal(created.body.user.plan.name, "Basic");

  const duplicate = await request(app)
    .post("/v1/users")
    .set("X-API-Key", firstApiKey)
    .send({ external_id: "demo-user" });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error.code, "user_already_exists");

  const assignedCustomPlan = await request(app)
    .post("/v1/users")
    .set("X-API-Key", firstApiKey)
    .send({ external_id: "custom-plan-user", plan_id: customPlanResult.rows[0].id });
  assert.equal(assignedCustomPlan.status, 201);
  assert.equal(assignedCustomPlan.body.user.plan.name, "User-test custom plan");

  const wrongPlanKind = await request(app)
    .post("/v1/users")
    .set("X-API-Key", firstApiKey)
    .send({ external_id: "wrong-plan-kind", plan_id: starterPlanId });
  assert.equal(wrongPlanKind.status, 404);

  const crossAccountCustomPlan = await request(app)
    .post("/v1/users")
    .set("X-API-Key", secondApiKey)
    .send({
      external_id: "cross-account-plan",
      plan_id: customPlanResult.rows[0].id,
    });
  assert.equal(crossAccountCustomPlan.status, 404);

  const otherAccountUser = await request(app)
    .post("/v1/users")
    .set("X-API-Key", secondApiKey)
    .send({ external_id: "private-user" });
  assert.equal(otherAccountUser.status, 201);

  const isolatedLookup = await request(app)
    .get("/v1/users/demo-user")
    .set("X-API-Key", secondApiKey);
  assert.equal(isolatedLookup.status, 404);
  const isolatedList = await request(app)
    .get("/v1/users")
    .set("X-API-Key", secondApiKey);
  assert.equal(isolatedList.status, 200);
  assert.deepEqual(
    isolatedList.body.users.map((user: { external_id: string }) => user.external_id),
    ["private-user"],
  );

  const lookup = await request(app)
    .get("/v1/users/demo-user")
    .set("X-API-Key", firstApiKey);
  assert.equal(lookup.status, 200);
  assert.equal(lookup.body.user.id, created.body.user.id);

  for (const externalId of ["page-user-a", "page-user-b", "page-user-c"]) {
    const response = await request(app)
      .post("/v1/users")
      .set("X-API-Key", firstApiKey)
      .send({ external_id: externalId });
    assert.equal(response.status, 201);
  }

  const firstPage = await request(app)
    .get("/v1/users?limit=2")
    .set("X-API-Key", firstApiKey);
  assert.equal(firstPage.status, 200);
  assert.equal(firstPage.body.users.length, 2);
  assert.equal(typeof firstPage.body.next_cursor, "string");

  const secondPage = await request(app)
    .get("/v1/users")
    .query({ limit: 2, cursor: firstPage.body.next_cursor })
    .set("X-API-Key", firstApiKey);
  assert.equal(secondPage.status, 200);
  assert.equal(secondPage.body.users.length, 2);
  assert.notEqual(firstPage.body.users[1].id, secondPage.body.users[0].id);

  const thirdPage = await request(app)
    .get("/v1/users")
    .query({ limit: 2, cursor: secondPage.body.next_cursor })
    .set("X-API-Key", firstApiKey);
  assert.equal(thirdPage.status, 200);
  assert.equal(thirdPage.body.users.length, 2);
  assert.equal(thirdPage.body.next_cursor, null);
  const pagedIds = [
    ...firstPage.body.users,
    ...secondPage.body.users,
    ...thirdPage.body.users,
  ].map((user: { id: string }) => user.id);
  assert.equal(new Set(pagedIds).size, pagedIds.length);

  const invalidCursor = await request(app)
    .get("/v1/users?cursor=invalid")
    .set("X-API-Key", firstApiKey);
  assert.equal(invalidCursor.status, 400);
  assert.equal(invalidCursor.body.error.code, "invalid_cursor");

  const otherAccountUserCount = await pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM users WHERE account_id = $1",
    [secondAccountId],
  );
  assert.equal(otherAccountUserCount.rows[0].count, "1");
});
