import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import request from "supertest";
import { createApp } from "../../src/app";
import { conditionalStrategy } from "../../src/consume/conditionalStrategy";
import { consume } from "../../src/consume/consumeService";
import { lockingStrategy } from "../../src/consume/lockingStrategy";
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

test("plans are account-scoped, predefined plans are read-only, and assignments update current limits", {
  skip: !connectionString,
}, async () => {
  const pool = requireTestPool();
  const { accountId, starterPlanId, basicPlanId } = requireSeed();
  const ownerKey = randomUUID() + randomUUID();
  const otherKey = randomUUID() + randomUUID();

  await pool.query(
    "UPDATE accounts SET api_key_hash = $1 WHERE id = $2",
    [hashApiKey(ownerKey), accountId],
  );
  const otherAccountResult = await pool.query<{ id: string }>(
    `INSERT INTO accounts (name, api_key_hash, plan_id)
     VALUES ('Plan-test other account', $1, $2)
     RETURNING id`,
    [hashApiKey(otherKey), starterPlanId],
  );
  const otherAccountId = otherAccountResult.rows[0].id;
  const otherUserResult = await pool.query<{ id: string }>(
    `INSERT INTO users (account_id, external_id, plan_id)
     VALUES ($1, 'plan-test-user', $2)
     RETURNING id`,
    [otherAccountId, basicPlanId],
  );
  const customUserPlanName = `Writer ${randomUUID().slice(0, 8)}`;
  const app = createApp({ pool, adminApiKey: "a".repeat(32) });
  const ownerHeaders = { "X-API-Key": ownerKey };
  const otherHeaders = { "X-API-Key": otherKey };

  const list = await request(app).get("/v1/plans").set(ownerHeaders);
  assert.equal(list.status, 200);
  assert.deepEqual(
    list.body.plans.map((plan: { name: string }) => plan.name).sort(),
    ["Basic", "Premium", "Pro", "Starter", "User-test custom plan"],
  );
  const userPlanList = await request(app)
    .get("/v1/plans?kind=user")
    .set(ownerHeaders);
  assert.equal(userPlanList.status, 200);
  assert.ok(userPlanList.body.plans.every((plan: { kind: string }) => plan.kind === "user"));
  const predefinedPlan = await request(app)
    .get(`/v1/plans/${basicPlanId}`)
    .set(ownerHeaders);
  assert.equal(predefinedPlan.status, 200);
  assert.equal(predefinedPlan.body.plan.is_predefined, true);

  const invalidPlan = await request(app)
    .post("/v1/plans")
    .set(ownerHeaders)
    .send({
      kind: "user",
      name: "unsafe",
      monthly_allowance: 9007199254740992,
      max_per_request: 1,
    });
  assert.equal(invalidPlan.status, 400);

  const accountPlanResponse = await request(app)
    .post("/v1/plans")
    .set(ownerHeaders)
    .send({
      kind: "account",
      name: "Team Plus",
      monthly_allowance: 5000,
      max_per_request: 250,
    });
  assert.equal(accountPlanResponse.status, 201);
  const accountPlan = accountPlanResponse.body.plan;
  assert.equal(accountPlan.is_predefined, false);

  const userPlanResponse = await request(app)
    .post("/v1/plans")
    .set(ownerHeaders)
    .send({
      kind: "user",
      name: customUserPlanName,
      monthly_allowance: 300,
      max_per_request: 40,
    });
  assert.equal(userPlanResponse.status, 201);
  const userPlan = userPlanResponse.body.plan;

  const duplicateName = await request(app)
    .post("/v1/plans")
    .set(ownerHeaders)
    .send({
      kind: "user",
      name: customUserPlanName,
      monthly_allowance: 400,
      max_per_request: 50,
    });
  assert.equal(duplicateName.status, 409);

  const visibleCustomPlan = await request(app)
    .get(`/v1/plans/${userPlan.id}`)
    .set(ownerHeaders);
  assert.equal(visibleCustomPlan.status, 200);
  const hiddenPlan = await request(app)
    .get(`/v1/plans/${userPlan.id}`)
    .set(otherHeaders);
  assert.equal(hiddenPlan.status, 404);

  const otherPlanList = await request(app).get("/v1/plans").set(otherHeaders);
  assert.equal(otherPlanList.status, 200);
  assert.equal(otherPlanList.body.plans.length, 4);

  const builtinPatch = await request(app)
    .patch(`/v1/plans/${basicPlanId}`)
    .set(ownerHeaders)
    .send({ monthly_allowance: 200 });
  assert.equal(builtinPatch.status, 404);

  const emptyPatch = await request(app)
    .patch(`/v1/plans/${userPlan.id}`)
    .set(ownerHeaders)
    .send({});
  assert.equal(emptyPatch.status, 400);

  const updatedPlan = await request(app)
    .patch(`/v1/plans/${userPlan.id}`)
    .set(ownerHeaders)
    .send({ monthly_allowance: 350, max_per_request: 45 });
  assert.equal(updatedPlan.status, 200);
  assert.equal(updatedPlan.body.plan.monthly_allowance, 350);
  assert.equal(updatedPlan.body.plan.max_per_request, 45);
  const duplicatePlanUpdate = await request(app)
    .patch(`/v1/plans/${userPlan.id}`)
    .set(ownerHeaders)
    .send({ name: "User-test custom plan" });
  assert.equal(duplicatePlanUpdate.status, 409);

  const foreignPlanPatch = await request(app)
    .patch(`/v1/plans/${userPlan.id}`)
    .set(otherHeaders)
    .send({ name: "Taken over" });
  assert.equal(foreignPlanPatch.status, 404);

  const createdUser = await request(app)
    .post("/v1/users")
    .set(ownerHeaders)
    .send({ external_id: "plan-assignment-user" });
  assert.equal(createdUser.status, 201);
  const usageMonth = "2026-10-01";
  await pool.query(
    "INSERT INTO account_usage (account_id, month, units_used) VALUES ($1, $2, 17)",
    [accountId, usageMonth],
  );
  await pool.query(
    "INSERT INTO user_usage (user_id, month, units_used) VALUES ($1, $2, 9)",
    [createdUser.body.user.id, usageMonth],
  );

  const assignUser = await request(app)
    .put("/v1/users/plan-assignment-user/plan")
    .set(ownerHeaders)
    .send({ plan_id: userPlan.id });
  assert.equal(assignUser.status, 200);
  assert.equal(assignUser.body.plan.id, userPlan.id);

  const userWithUpdatedPlan = await request(app)
    .get("/v1/users/plan-assignment-user")
    .set(ownerHeaders);
  assert.equal(userWithUpdatedPlan.status, 200);
  assert.equal(userWithUpdatedPlan.body.user.plan.monthly_allowance, 350);
  assert.equal(userWithUpdatedPlan.body.user.plan.max_per_request, 45);
  const retainedUsage = await pool.query<{
    account_units: string;
    user_units: string;
  }>(
    `SELECT au.units_used::text AS account_units, uu.units_used::text AS user_units
     FROM account_usage au
     JOIN user_usage uu ON uu.month = au.month
     WHERE au.account_id = $1 AND uu.user_id = $2 AND au.month = $3`,
    [accountId, createdUser.body.user.id, usageMonth],
  );
  assert.deepEqual(retainedUsage.rows[0], { account_units: "17", user_units: "9" });

  const wrongKindForUser = await request(app)
    .put("/v1/users/plan-assignment-user/plan")
    .set(ownerHeaders)
    .send({ plan_id: accountPlan.id });
  assert.equal(wrongKindForUser.status, 404);

  const assignAccount = await request(app)
    .put("/v1/account/plan")
    .set(ownerHeaders)
    .send({ plan_id: accountPlan.id });
  assert.equal(assignAccount.status, 200);
  assert.equal(assignAccount.body.plan.id, accountPlan.id);

  const updatedAccountPlan = await request(app)
    .patch(`/v1/plans/${accountPlan.id}`)
    .set(ownerHeaders)
    .send({ monthly_allowance: 5500 });
  assert.equal(updatedAccountPlan.status, 200);

  const currentAccount = await request(app)
    .get("/v1/account")
    .set(ownerHeaders);
  assert.equal(currentAccount.status, 200);
  assert.equal(currentAccount.body.plan.id, accountPlan.id);
  assert.equal(currentAccount.body.plan.monthly_allowance, 5500);

  const wrongKindForAccount = await request(app)
    .put("/v1/account/plan")
    .set(ownerHeaders)
    .send({ plan_id: userPlan.id });
  assert.equal(wrongKindForAccount.status, 404);

  const foreignPlanAssignment = await request(app)
    .put("/v1/users/plan-test-user/plan")
    .set(otherHeaders)
    .send({ plan_id: userPlan.id });
  assert.equal(foreignPlanAssignment.status, 404);

  const missingUserAssignment = await request(app)
    .put("/v1/users/no-such-user/plan")
    .set(ownerHeaders)
    .send({ plan_id: userPlan.id });
  assert.equal(missingUserAssignment.status, 404);

  const hiddenForeignUser = await request(app)
    .get("/v1/users/plan-test-user")
    .set(ownerHeaders);
  assert.equal(hiddenForeignUser.status, 404);
  assert.ok(otherUserResult.rows[0].id);
});

test("consume enforces both plan levels, replays idempotently, and serializes concurrent quota use", {
  skip: !connectionString,
}, async () => {
  const pool = requireTestPool();
  const key = randomUUID() + randomUUID();
  const accountPlan = await pool.query<{ id: string }>(
    `INSERT INTO plans (kind, owner_account_id, name, monthly_allowance, max_per_request)
     VALUES ('account', NULL, $1, 8, 5)
     RETURNING id`,
    [`Consume account ${randomUUID()}`],
  );
  const userPlan = await pool.query<{ id: string }>(
    `INSERT INTO plans (kind, owner_account_id, name, monthly_allowance, max_per_request)
     VALUES ('user', NULL, $1, 6, 3)
     RETURNING id`,
    [`Consume user ${randomUUID()}`],
  );
  const account = await pool.query<{ id: string }>(
    `INSERT INTO accounts (name, api_key_hash, plan_id)
     VALUES ('Consume test account', $1, $2)
     RETURNING id`,
    [hashApiKey(key), accountPlan.rows[0].id],
  );
  const firstUser = await pool.query<{ id: string }>(
    `INSERT INTO users (account_id, external_id, plan_id)
     VALUES ($1, 'quota-user', $2)
     RETURNING id`,
    [account.rows[0].id, userPlan.rows[0].id],
  );
  const otherUserPlan = await pool.query<{ id: string }>(
    `INSERT INTO plans (kind, owner_account_id, name, monthly_allowance, max_per_request)
     VALUES ('user', NULL, $1, 100, 10)
     RETURNING id`,
    [`Consume other user ${randomUUID()}`],
  );
  await pool.query(
    `INSERT INTO users (account_id, external_id, plan_id)
     VALUES ($1, 'account-limited-user', $2)`,
    [account.rows[0].id, otherUserPlan.rows[0].id],
  );

  const app = createApp({ pool, adminApiKey: "a".repeat(32) });
  const api = () => request(app).post("/v1/consume").set("X-API-Key", key);

  const unauthenticated = await request(app)
    .post("/v1/consume")
    .send({ user_id: "quota-user", units: 1, request_id: "no-key" });
  assert.equal(unauthenticated.status, 401);
  const invalidUnits = await api().send({
    user_id: "quota-user",
    units: 1.5,
    request_id: "fractional-units",
  });
  assert.equal(invalidUnits.status, 400);

  const perRequestRejected = await api().send({
    user_id: "quota-user",
    units: 4,
    request_id: "user-per-request",
  });
  assert.equal(perRequestRejected.status, 200);
  assert.equal(perRequestRejected.body.accepted, false);
  assert.deepEqual(perRequestRejected.body.rejected_by, {
    level: "user",
    rule: "per_request",
  });
  assert.equal(perRequestRejected.body.user.used, 0);

  const replayedRejection = await api().send({
    user_id: "quota-user",
    units: 4,
    request_id: "user-per-request",
  });
  assert.equal(replayedRejection.status, 200);
  assert.equal(replayedRejection.body.replayed, true);
  assert.equal(replayedRejection.body.accepted, false);
  assert.deepEqual(
    { ...replayedRejection.body, replayed: false },
    perRequestRejected.body,
  );
  const idConflict = await api().send({
    user_id: "quota-user",
    units: 3,
    request_id: "user-per-request",
  });
  assert.equal(idConflict.status, 409);
  const userConflict = await api().send({
    user_id: "account-limited-user",
    units: 4,
    request_id: "user-per-request",
  });
  assert.equal(userConflict.status, 409);

  const originalAcceptedDecisions = new Map<string, object>();
  for (const requestId of ["accepted-one", "accepted-two"]) {
    const accepted = await api().send({
      user_id: "quota-user",
      units: 3,
      request_id: requestId,
    });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.accepted, true);
    assert.equal(accepted.body.user.used, requestId === "accepted-one" ? 3 : 6);
    assert.equal(accepted.body.account.used, requestId === "accepted-one" ? 3 : 6);
    originalAcceptedDecisions.set(requestId, accepted.body);
  }

  const acceptedReplay = await api().send({
    user_id: "quota-user",
    units: 3,
    request_id: "accepted-one",
  });
  assert.equal(acceptedReplay.status, 200);
  assert.equal(acceptedReplay.body.replayed, true);
  assert.deepEqual(
    { ...acceptedReplay.body, replayed: false },
    originalAcceptedDecisions.get("accepted-one"),
  );

  const userMonthlyRejected = await api().send({
    user_id: "quota-user",
    units: 1,
    request_id: "user-monthly",
  });
  assert.equal(userMonthlyRejected.body.accepted, false);
  assert.deepEqual(userMonthlyRejected.body.rejected_by, {
    level: "user",
    rule: "monthly_allowance",
  });

  const accountPerRequestRejected = await api().send({
    user_id: "account-limited-user",
    units: 6,
    request_id: "account-per-request",
  });
  assert.equal(accountPerRequestRejected.body.accepted, false);
  assert.deepEqual(accountPerRequestRejected.body.rejected_by, {
    level: "account",
    rule: "per_request",
  });

  const accountMonthlyRejected = await api().send({
    user_id: "account-limited-user",
    units: 3,
    request_id: "account-monthly",
  });
  assert.equal(accountMonthlyRejected.body.accepted, false);
  assert.deepEqual(accountMonthlyRejected.body.rejected_by, {
    level: "account",
    rule: "monthly_allowance",
  });

  const usage = await pool.query<{ account: string; user: string }>(
    `SELECT au.units_used::text AS account, uu.units_used::text AS user
     FROM account_usage au
     JOIN user_usage uu ON uu.month = au.month
     WHERE au.account_id = $1 AND uu.user_id = $2
       AND au.month = date_trunc('month', now() AT TIME ZONE 'UTC')::date`,
    [account.rows[0].id, firstUser.rows[0].id],
  );
  assert.deepEqual(usage.rows[0], { account: "6", user: "6" });

  const updatedUserPlan = await pool.query<{ id: string }>(
    `INSERT INTO plans (
       kind, owner_account_id, name, monthly_allowance, max_per_request
     )
     VALUES ('user', $1, $2, 0, 5)
     RETURNING id`,
    [account.rows[0].id, `Tightened plan ${randomUUID()}`],
  );
  const assignmentClient = await pool.connect();
  await assignmentClient.query("BEGIN");
  await assignmentClient.query(
    "SELECT id FROM accounts WHERE id = $1 FOR UPDATE",
    [account.rows[0].id],
  );
  await assignmentClient.query(
    "UPDATE users SET plan_id = $2 WHERE id = $1",
    [firstUser.rows[0].id, updatedUserPlan.rows[0].id],
  );
  const pendingConsumption = request(app)
    .post("/v1/consume")
    .set("X-API-Key", key)
    .send({
      user_id: "quota-user",
      units: 1,
      request_id: "plan-change-in-flight",
    });
  await new Promise((resolve) => setTimeout(resolve, 50));
  await assignmentClient.query("COMMIT");
  assignmentClient.release();
  const planChangeDecision = await pendingConsumption;
  assert.equal(planChangeDecision.status, 200);
  assert.equal(planChangeDecision.body.accepted, false);
  assert.deepEqual(planChangeDecision.body.rejected_by, {
    level: "user",
    rule: "monthly_allowance",
  });
  assert.equal(
    planChangeDecision.body.user.monthly_allowance,
    0,
  );

  const concurrentAccountPlan = await pool.query<{ id: string }>(
    `INSERT INTO plans (kind, owner_account_id, name, monthly_allowance, max_per_request)
     VALUES ('account', NULL, $1, 5, 5)
     RETURNING id`,
    [`Concurrent account ${randomUUID()}`],
  );
  const concurrentUserPlan = await pool.query<{ id: string }>(
    `INSERT INTO plans (kind, owner_account_id, name, monthly_allowance, max_per_request)
     VALUES ('user', NULL, $1, 10, 1)
     RETURNING id`,
    [`Concurrent user ${randomUUID()}`],
  );
  const concurrentKey = randomUUID() + randomUUID();
  const concurrentAccount = await pool.query<{ id: string }>(
    `INSERT INTO accounts (name, api_key_hash, plan_id)
     VALUES ('Concurrent consume account', $1, $2)
     RETURNING id`,
    [hashApiKey(concurrentKey), concurrentAccountPlan.rows[0].id],
  );
  await pool.query(
    `INSERT INTO users (account_id, external_id, plan_id)
     VALUES ($1, 'racing-user', $2)`,
    [concurrentAccount.rows[0].id, concurrentUserPlan.rows[0].id],
  );

  const concurrentResults = await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      request(app)
        .post("/v1/consume")
        .set("X-API-Key", concurrentKey)
        .send({
          user_id: "racing-user",
          units: 1,
          request_id: `parallel-${index}`,
        }),
    ),
  );
  assert.ok(concurrentResults.every((result) => result.status === 200));
  assert.equal(
    concurrentResults.filter((result) => result.body.accepted).length,
    5,
  );

  const concurrentUsage = await pool.query<{ account: string; user: string }>(
    `SELECT au.units_used::text AS account, uu.units_used::text AS user
     FROM account_usage au
     JOIN users u ON u.account_id = au.account_id
     JOIN user_usage uu ON uu.user_id = u.id AND uu.month = au.month
     WHERE au.account_id = $1 AND u.external_id = 'racing-user'
       AND au.month = date_trunc('month', now() AT TIME ZONE 'UTC')::date`,
    [concurrentAccount.rows[0].id],
  );
  assert.deepEqual(concurrentUsage.rows[0], { account: "5", user: "5" });

  const idempotencyKey = randomUUID() + randomUUID();
  const idempotencyAccount = await pool.query<{ id: string }>(
    `INSERT INTO accounts (name, api_key_hash, plan_id)
     VALUES ('Concurrent idempotency account', $1, $2)
     RETURNING id`,
    [hashApiKey(idempotencyKey), concurrentAccountPlan.rows[0].id],
  );
  await pool.query(
    `INSERT INTO users (account_id, external_id, plan_id)
     VALUES ($1, 'same-request-user', $2)`,
    [idempotencyAccount.rows[0].id, concurrentUserPlan.rows[0].id],
  );
  const duplicateRequestResults = await Promise.all(
    Array.from({ length: 20 }, () =>
      request(app)
        .post("/v1/consume")
        .set("X-API-Key", idempotencyKey)
        .send({
          user_id: "same-request-user",
          units: 1,
          request_id: "same-concurrent-id",
        }),
    ),
  );
  assert.ok(duplicateRequestResults.every((result) => result.status === 200));
  assert.equal(
    duplicateRequestResults.filter((result) => result.body.replayed === false).length,
    1,
  );
  assert.equal(
    duplicateRequestResults.filter((result) => result.body.replayed === true).length,
    19,
  );
  assert.ok(duplicateRequestResults.every((result) => result.body.accepted));
  const firstDecision = {
    ...duplicateRequestResults[0].body,
    replayed: false,
  };
  for (const result of duplicateRequestResults) {
    assert.deepEqual({ ...result.body, replayed: false }, firstDecision);
  }
  const idempotentUsage = await pool.query<{
    account: string;
    user: string;
    request_count: string;
  }>(
    `SELECT au.units_used::text AS account, uu.units_used::text AS user,
            (SELECT count(*)::text
             FROM requests r
             WHERE r.account_id = au.account_id
               AND r.request_id = 'same-concurrent-id') AS request_count
     FROM account_usage au
     JOIN users u ON u.account_id = au.account_id
     JOIN user_usage uu ON uu.user_id = u.id AND uu.month = au.month
     WHERE au.account_id = $1 AND u.external_id = 'same-request-user'
       AND au.month = date_trunc('month', now() AT TIME ZONE 'UTC')::date`,
    [idempotencyAccount.rows[0].id],
  );
  assert.deepEqual(idempotentUsage.rows[0], {
    account: "1",
    user: "1",
    request_count: "1",
  });
});

test("conditional strategy preserves quota limits, request replays, and usage totals under concurrency", {
  skip: !connectionString,
}, async () => {
  const pool = requireTestPool();
  const key = randomUUID() + randomUUID();
  const accountPlan = await pool.query<{ id: string }>(
    `INSERT INTO plans (kind, owner_account_id, name, monthly_allowance, max_per_request)
     VALUES ('account', NULL, $1, 7, 5)
     RETURNING id`,
    [`Conditional account ${randomUUID()}`],
  );
  const userPlan = await pool.query<{ id: string }>(
    `INSERT INTO plans (kind, owner_account_id, name, monthly_allowance, max_per_request)
     VALUES ('user', NULL, $1, 100, 10)
     RETURNING id`,
    [`Conditional user ${randomUUID()}`],
  );
  const account = await pool.query<{ id: string }>(
    `INSERT INTO accounts (name, api_key_hash, plan_id)
     VALUES ('Conditional strategy account', $1, $2)
     RETURNING id`,
    [hashApiKey(key), accountPlan.rows[0].id],
  );
  for (const externalId of ["conditional-user-a", "conditional-user-b"]) {
    await pool.query(
      `INSERT INTO users (account_id, external_id, plan_id)
       VALUES ($1, $2, $3)`,
      [account.rows[0].id, externalId, userPlan.rows[0].id],
    );
  }

  const app = createApp({
    pool,
    adminApiKey: "a".repeat(32),
    consumptionStrategy: conditionalStrategy,
  });
  const api = (userId: string, requestId: string) =>
    request(app)
      .post("/v1/consume")
      .set("X-API-Key", key)
      .send({ user_id: userId, units: 1, request_id: requestId });

  const userPerRequestRejected = await request(app)
    .post("/v1/consume")
    .set("X-API-Key", key)
    .send({
      user_id: "conditional-user-a",
      units: 11,
      request_id: "conditional-user-per-request",
    });
  assert.equal(userPerRequestRejected.status, 200);
  assert.equal(userPerRequestRejected.body.accepted, false);
  assert.deepEqual(userPerRequestRejected.body.rejected_by, {
    level: "user",
    rule: "per_request",
  });

  const accountPerRequestRejected = await request(app)
    .post("/v1/consume")
    .set("X-API-Key", key)
    .send({
      user_id: "conditional-user-a",
      units: 6,
      request_id: "conditional-account-per-request",
    });
  assert.equal(accountPerRequestRejected.status, 200);
  assert.equal(accountPerRequestRejected.body.accepted, false);
  assert.deepEqual(accountPerRequestRejected.body.rejected_by, {
    level: "account",
    rule: "per_request",
  });

  const duplicateResults = await Promise.all(
    Array.from({ length: 8 }, () =>
      api("conditional-user-a", "conditional-shared-request"),
    ),
  );
  assert.ok(duplicateResults.every((result) => result.status === 200));
  assert.equal(
    duplicateResults.filter((result) => result.body.replayed === false).length,
    1,
  );
  assert.ok(duplicateResults.every((result) => result.body.accepted));

  const competingResults = await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      api(
        index % 2 === 0 ? "conditional-user-a" : "conditional-user-b",
        `conditional-competing-${index}`,
      ),
    ),
  );
  assert.ok(competingResults.every((result) => result.status === 200));
  assert.equal(
    competingResults.filter((result) => result.body.accepted).length,
    6,
  );
  assert.ok(
    competingResults
      .filter((result) => !result.body.accepted)
      .every((result) =>
        result.body.rejected_by.level === "account" &&
        result.body.rejected_by.rule === "monthly_allowance"
      ),
  );
  const rejectedIndex = competingResults.findIndex(
    (result) => !result.body.accepted,
  );
  assert.notEqual(rejectedIndex, -1);
  const rejectedReplay = await api(
    rejectedIndex % 2 === 0 ? "conditional-user-a" : "conditional-user-b",
    `conditional-competing-${rejectedIndex}`,
  );
  assert.equal(rejectedReplay.status, 200);
  assert.equal(rejectedReplay.body.replayed, true);
  assert.equal(rejectedReplay.body.accepted, false);
  assert.deepEqual(
    { ...rejectedReplay.body, replayed: false },
    competingResults[rejectedIndex].body,
  );

  const usage = await pool.query<{
    account: string;
    users: string;
    accepted_requests: string;
  }>(
    `SELECT au.units_used::text AS account,
            SUM(uu.units_used)::text AS users,
            (SELECT COALESCE(SUM(r.units), 0)::text
             FROM requests r
             WHERE r.account_id = a.id AND r.outcome = 'accepted') AS accepted_requests
     FROM accounts a
     JOIN account_usage au ON au.account_id = a.id
     JOIN users u ON u.account_id = a.id
     JOIN user_usage uu ON uu.user_id = u.id AND uu.month = au.month
     WHERE a.id = $1
       AND au.month = date_trunc('month', now() AT TIME ZONE 'UTC')::date
     GROUP BY a.id, au.units_used`,
    [account.rows[0].id],
  );
  assert.deepEqual(usage.rows[0], {
    account: "7",
    users: "7",
    accepted_requests: "7",
  });
});

test("conditional strategy enforces per-user monthly limits under concurrent consumption", {
  skip: !connectionString,
}, async () => {
  const pool = requireTestPool();
  const key = randomUUID() + randomUUID();
  const accountPlan = await pool.query<{ id: string }>(
    `INSERT INTO plans (kind, owner_account_id, name, monthly_allowance, max_per_request)
     VALUES ('account', NULL, $1, 100, 10)
     RETURNING id`,
    [`Conditional user-limit account ${randomUUID()}`],
  );
  const userPlan = await pool.query<{ id: string }>(
    `INSERT INTO plans (kind, owner_account_id, name, monthly_allowance, max_per_request)
     VALUES ('user', NULL, $1, 3, 10)
     RETURNING id`,
    [`Conditional user-limit plan ${randomUUID()}`],
  );
  const account = await pool.query<{ id: string }>(
    `INSERT INTO accounts (name, api_key_hash, plan_id)
     VALUES ('Conditional user-limit account', $1, $2)
     RETURNING id`,
    [hashApiKey(key), accountPlan.rows[0].id],
  );
  await pool.query(
    `INSERT INTO users (account_id, external_id, plan_id)
     VALUES ($1, 'conditional-limited-user', $2)`,
    [account.rows[0].id, userPlan.rows[0].id],
  );

  const app = createApp({
    pool,
    adminApiKey: "a".repeat(32),
    consumptionStrategy: conditionalStrategy,
  });

  const results = await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      request(app)
        .post("/v1/consume")
        .set("X-API-Key", key)
        .send({
          user_id: "conditional-limited-user",
          units: 1,
          request_id: `conditional-user-race-${index}`,
        }),
    ),
  );

  assert.ok(results.every((result) => result.status === 200));
  assert.equal(results.filter((result) => result.body.accepted).length, 3);
  assert.ok(
    results
      .filter((result) => !result.body.accepted)
      .every((result) =>
        result.body.rejected_by.level === "user" &&
        result.body.rejected_by.rule === "monthly_allowance"
      ),
  );

  const usage = await pool.query<{ account: string; user: string }>(
    `SELECT au.units_used::text AS account, uu.units_used::text AS user
     FROM account_usage au
     JOIN users u ON u.account_id = au.account_id
     JOIN user_usage uu ON uu.user_id = u.id AND uu.month = au.month
     WHERE au.account_id = $1 AND u.external_id = 'conditional-limited-user'
       AND au.month = date_trunc('month', now() AT TIME ZONE 'UTC')::date`,
    [account.rows[0].id],
  );
  assert.deepEqual(usage.rows[0], { account: "3", user: "3" });
});

test("locking and conditional strategies produce identical decisions", {
  skip: !connectionString,
}, async () => {
  const pool = requireTestPool();
  const { starterPlanId, basicPlanId } = requireSeed();
  const accountIds: string[] = [];
  const userExternalId = "strategy-parity-user";

  for (let index = 0; index < 2; index++) {
    const accountResult = await pool.query<{ id: string }>(
      `INSERT INTO accounts (name, api_key_hash, plan_id)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [
        `Strategy parity ${index} ${randomUUID()}`,
        hashApiKey(randomUUID() + randomUUID()),
        starterPlanId,
      ],
    );
    const accountId = accountResult.rows[0].id;
    accountIds.push(accountId);
    const userResult = await pool.query<{ id: string }>(
      `INSERT INTO users (account_id, external_id, plan_id)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [accountId, userExternalId, basicPlanId],
    );
    await pool.query(
      `INSERT INTO account_usage (account_id, month, units_used)
       VALUES ($1, date_trunc('month', now() AT TIME ZONE 'UTC')::date, 0)`,
      [accountId],
    );
    await pool.query(
      `INSERT INTO user_usage (user_id, month, units_used)
       VALUES ($1, date_trunc('month', now() AT TIME ZONE 'UTC')::date, 0)`,
      [userResult.rows[0].id],
    );
  }

  const input = {
    userExternalId,
    units: 3,
    requestId: "strategy-parity-accepted",
  };
  const lockingAccepted = await consume(
    pool,
    { ...input, accountId: accountIds[0] },
    lockingStrategy,
  );
  const conditionalAccepted = await consume(
    pool,
    { ...input, accountId: accountIds[1] },
    conditionalStrategy,
  );
  assert.deepEqual(
    {
      accepted: lockingAccepted.accepted,
      account: lockingAccepted.account,
      user: lockingAccepted.user,
    },
    {
      accepted: conditionalAccepted.accepted,
      account: conditionalAccepted.account,
      user: conditionalAccepted.user,
    },
  );

  const rejectedInput = { ...input, units: 21, requestId: "strategy-parity-rejected" };
  const lockingRejected = await consume(
    pool,
    { ...rejectedInput, accountId: accountIds[0] },
    lockingStrategy,
  );
  const conditionalRejected = await consume(
    pool,
    { ...rejectedInput, accountId: accountIds[1] },
    conditionalStrategy,
  );
  assert.deepEqual(
    {
      accepted: lockingRejected.accepted,
      rejected_by: lockingRejected.rejected_by,
      account: lockingRejected.account,
      user: lockingRejected.user,
    },
    {
      accepted: conditionalRejected.accepted,
      rejected_by: conditionalRejected.rejected_by,
      account: conditionalRejected.account,
      user: conditionalRejected.user,
    },
  );
});

test("consume reports a locked account as busy and leaves no request claim", {
  skip: !connectionString,
}, async () => {
  const pool = requireTestPool();
  const { starterPlanId, basicPlanId } = requireSeed();
  const key = randomUUID() + randomUUID();
  const account = await pool.query<{ id: string }>(
    `INSERT INTO accounts (name, api_key_hash, plan_id)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [`Busy timeout account ${randomUUID()}`, hashApiKey(key), starterPlanId],
  );
  await pool.query(
    `INSERT INTO users (account_id, external_id, plan_id)
     VALUES ($1, 'busy-timeout-user', $2)`,
    [account.rows[0].id, basicPlanId],
  );
  const blocker = await pool.connect();
  await blocker.query("BEGIN");
  try {
    await blocker.query(
      "SELECT id FROM accounts WHERE id = $1 FOR UPDATE",
      [account.rows[0].id],
    );
    const response = await request(
      createApp({ pool, adminApiKey: "a".repeat(32) }),
    )
      .post("/v1/consume")
      .set("X-API-Key", key)
      .send({
        user_id: "busy-timeout-user",
        units: 1,
        request_id: "busy-timeout-request",
      });

    assert.equal(response.status, 503);
    assert.deepEqual(response.body.error, {
      code: "busy",
      message: "Consumption is temporarily busy; retry the request",
    });
    const requestCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM requests
       WHERE account_id = $1 AND request_id = 'busy-timeout-request'`,
      [account.rows[0].id],
    );
    assert.equal(requestCount.rows[0].count, "0");
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
  }
});

test("usage summaries and request history are filtered, paginated, and account-scoped", {
  skip: !connectionString,
}, async () => {
  const pool = requireTestPool();
  const accountKey = randomUUID() + randomUUID();
  const otherAccountKey = randomUUID() + randomUUID();
  const accountPlan = await pool.query<{ id: string }>(
    `INSERT INTO plans (kind, owner_account_id, name, monthly_allowance, max_per_request)
     VALUES ('account', NULL, $1, 20, 10)
     RETURNING id`,
    [`Usage API account ${randomUUID()}`],
  );
  const userPlan = await pool.query<{ id: string }>(
    `INSERT INTO plans (kind, owner_account_id, name, monthly_allowance, max_per_request)
     VALUES ('user', NULL, $1, 12, 5)
     RETURNING id`,
    [`Usage API user ${randomUUID()}`],
  );
  const account = await pool.query<{ id: string }>(
    `INSERT INTO accounts (name, api_key_hash, plan_id)
     VALUES ('Usage API account', $1, $2)
     RETURNING id`,
    [hashApiKey(accountKey), accountPlan.rows[0].id],
  );
  const user = await pool.query<{ id: string }>(
    `INSERT INTO users (account_id, external_id, plan_id)
     VALUES ($1, 'usage-api-user', $2)
     RETURNING id`,
    [account.rows[0].id, userPlan.rows[0].id],
  );
  const otherAccount = await pool.query<{ id: string }>(
    `INSERT INTO accounts (name, api_key_hash, plan_id)
     VALUES ('Other usage API account', $1, $2)
     RETURNING id`,
    [hashApiKey(otherAccountKey), accountPlan.rows[0].id],
  );
  await pool.query(
    `INSERT INTO users (account_id, external_id, plan_id)
     VALUES ($1, 'usage-api-user', $2)`,
    [otherAccount.rows[0].id, userPlan.rows[0].id],
  );

  const app = createApp({ pool, adminApiKey: "a".repeat(32) });
  const api = () => request(app);
  for (const [requestId, units] of [
    ["history-accepted-1", 2],
    ["history-accepted-2", 3],
    ["history-accepted-3", 1],
    ["history-rejected", 6],
  ] as const) {
    const response = await api()
      .post("/v1/consume")
      .set("X-API-Key", accountKey)
      .send({ user_id: "usage-api-user", units, request_id: requestId });
    assert.equal(response.status, 200);
    assert.equal(response.body.accepted, requestId !== "history-rejected");
  }

  const currentUsage = await api().get("/v1/usage").set("X-API-Key", accountKey);
  assert.equal(currentUsage.status, 200);
  assert.match(currentUsage.body.month, /^\d{4}-\d{2}$/);
  assert.equal(currentUsage.body.account.units_used, 6);
  assert.equal(currentUsage.body.account.remaining, 14);
  assert.equal(currentUsage.body.users.length, 1);
  assert.equal(currentUsage.body.users[0].user_id, "usage-api-user");
  assert.equal(currentUsage.body.users[0].units_used, 6);
  assert.equal(currentUsage.body.users[0].remaining, 6);

  const currentUserUsage = await api()
    .get("/v1/users/usage-api-user/usage")
    .set("X-API-Key", accountKey);
  assert.equal(currentUserUsage.status, 200);
  assert.equal(currentUserUsage.body.user.units_used, 6);
  assert.equal(currentUserUsage.body.account.units_used, 6);
  assert.equal(currentUserUsage.body.user.plan.id, userPlan.rows[0].id);

  const historicalMonthResult = await pool.query<{ month: string }>(
    `SELECT (date_trunc('month', transaction_timestamp() AT TIME ZONE 'UTC')
             - interval '1 month')::date::text AS month`,
  );
  const historicalMonth = historicalMonthResult.rows[0].month;
  await pool.query(
    `INSERT INTO account_usage (account_id, month, units_used)
     VALUES ($1, $2, 9)`,
    [account.rows[0].id, historicalMonth],
  );
  await pool.query(
    `INSERT INTO user_usage (user_id, month, units_used)
     VALUES ($1, $2, 7)`,
    [user.rows[0].id, historicalMonth],
  );
  await pool.query(
    `UPDATE requests
     SET month = $3,
         created_at = created_at - interval '1 month'
     WHERE account_id = $1 AND request_id = $2`,
    [account.rows[0].id, "history-accepted-1", historicalMonth],
  );
  const historicalMonthLabel = historicalMonth.slice(0, 7);

  const historicalUsage = await api()
    .get("/v1/usage")
    .set("X-API-Key", accountKey)
    .query({ month: historicalMonthLabel });
  assert.equal(historicalUsage.status, 200);
  assert.equal(historicalUsage.body.month, historicalMonthLabel);
  assert.equal(historicalUsage.body.account.units_used, 9);
  assert.equal(historicalUsage.body.account.remaining, null);
  assert.equal(historicalUsage.body.users[0].units_used, 7);
  assert.equal(historicalUsage.body.users[0].remaining, null);

  const userUsageFromHistory = await api()
    .get("/v1/users/usage-api-user/usage")
    .set("X-API-Key", accountKey)
    .query({ month: historicalMonthLabel });
  assert.equal(userUsageFromHistory.status, 200);
  assert.equal(userUsageFromHistory.body.user.units_used, 7);
  assert.equal(userUsageFromHistory.body.user.remaining, null);

  const emptyHistory = await api()
    .get("/v1/usage")
    .set("X-API-Key", accountKey)
    .query({ month: "2020-01" });
  assert.equal(emptyHistory.status, 200);
  assert.equal(emptyHistory.body.account.units_used, 0);
  assert.equal(emptyHistory.body.account.remaining, null);
  assert.equal(emptyHistory.body.users[0].units_used, 0);

  const pagedFirst = await api()
    .get("/v1/requests")
    .set("X-API-Key", accountKey)
    .query({ limit: 2 });
  assert.equal(pagedFirst.status, 200);
  assert.equal(pagedFirst.body.requests.length, 2);
  assert.equal(typeof pagedFirst.body.next_cursor, "string");
  const pagedSecond = await api()
    .get("/v1/requests")
    .set("X-API-Key", accountKey)
    .query({ limit: 2, cursor: pagedFirst.body.next_cursor });
  assert.equal(pagedSecond.status, 200);
  assert.equal(pagedSecond.body.requests.length, 2);
  assert.equal(pagedSecond.body.next_cursor, null);
  const pagedRequestIds = [
    ...pagedFirst.body.requests,
    ...pagedSecond.body.requests,
  ].map((entry: { request_id: string }) => entry.request_id);
  assert.equal(new Set(pagedRequestIds).size, 4);
  assert.ok(pagedFirst.body.requests.some(
    (entry: { decision: { account: { plan: string } } }) =>
      entry.decision.account.plan === currentUsage.body.account.plan.name,
  ));

  await pool.query(
    "UPDATE plans SET monthly_allowance = 13 WHERE id = $1",
    [userPlan.rows[0].id],
  );
  const filteredHistory = await api()
    .get("/v1/requests")
    .set("X-API-Key", accountKey)
    .query({ user_id: "usage-api-user", month: historicalMonthLabel, outcome: "accepted" });
  assert.equal(filteredHistory.status, 200);
  assert.equal(filteredHistory.body.requests.length, 1);
  assert.equal(filteredHistory.body.requests[0].request_id, "history-accepted-1");
  assert.equal(filteredHistory.body.requests[0].outcome, "accepted");
  assert.equal(filteredHistory.body.requests[0].decision.accepted, true);
  assert.equal(
    filteredHistory.body.requests[0].decision.user.monthly_allowance,
    12,
  );

  const rejectedHistory = await api()
    .get("/v1/requests")
    .set("X-API-Key", accountKey)
    .query({ outcome: "rejected" });
  assert.equal(rejectedHistory.status, 200);
  assert.equal(rejectedHistory.body.requests.length, 1);
  assert.deepEqual(rejectedHistory.body.requests[0].rejected_by, {
    level: "user",
    rule: "per_request",
  });

  const invalidMonth = await api()
    .get("/v1/usage")
    .set("X-API-Key", accountKey)
    .query({ month: "2026-13" });
  assert.equal(invalidMonth.status, 400);
  const invalidHistoryMonth = await api()
    .get("/v1/requests")
    .set("X-API-Key", accountKey)
    .query({ month: "nope" });
  assert.equal(invalidHistoryMonth.status, 400);
  const invalidCursor = await api()
    .get("/v1/requests")
    .set("X-API-Key", accountKey)
    .query({ cursor: "invalid" });
  assert.equal(invalidCursor.status, 400);
  const unknownUser = await api()
    .get("/v1/users/missing-user/usage")
    .set("X-API-Key", accountKey);
  assert.equal(unknownUser.status, 404);
  const unknownHistoryFilter = await api()
    .get("/v1/requests")
    .set("X-API-Key", accountKey)
    .query({ user_id: "missing-user" });
  assert.equal(unknownHistoryFilter.status, 404);

  const isolatedHistory = await request(app)
    .get("/v1/requests")
    .set("X-API-Key", otherAccountKey);
  assert.equal(isolatedHistory.status, 200);
  assert.deepEqual(isolatedHistory.body.requests, []);
  const isolatedUsage = await request(app)
    .get("/v1/usage")
    .set("X-API-Key", otherAccountKey);
  assert.equal(isolatedUsage.status, 200);
  assert.equal(isolatedUsage.body.account.units_used, 0);
  assert.equal(isolatedUsage.body.users.length, 1);
  assert.equal(isolatedUsage.body.users[0].units_used, 0);
});
