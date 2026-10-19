import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import request from "supertest";
import { createApp } from "../../src/app";
import { conditionalStrategy } from "../../src/consume/conditionalStrategy";
import { consume, getConsumeTimeoutCode } from "../../src/consume/consumeService";
import { lockingStrategy } from "../../src/consume/lockingStrategy";
import { hashApiKey } from "../../src/middleware/auth";
import { connectionString, getSchemaName, registerDbHooks, requireSeed, requireTestPool } from "./helpers";

registerDbHooks();

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

test("first requests for a new month create one usage row under concurrency", {
  skip: !connectionString,
}, async () => {
  const pool = requireTestPool();
  const { starterPlanId, basicPlanId } = requireSeed();
  const key = randomUUID() + randomUUID();
  const account = await pool.query<{ id: string }>(
    `INSERT INTO accounts (name, api_key_hash, plan_id)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [`First-month race ${randomUUID()}`, hashApiKey(key), starterPlanId],
  );
  const externalId = `first-month-${randomUUID()}`;
  const user = await pool.query<{ id: string }>(
    `INSERT INTO users (account_id, external_id, plan_id)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [account.rows[0].id, externalId, basicPlanId],
  );
  const app = createApp({ pool, adminApiKey: "a".repeat(32) });

  const results = await Promise.all(
    ["first-month-a", "first-month-b"].map((requestId) =>
      request(app)
        .post("/v1/consume")
        .set("X-API-Key", key)
        .send({
          user_id: externalId,
          units: 1,
          request_id: requestId,
        }),
    ),
  );

  assert.ok(results.every((result) => result.status === 200));
  assert.ok(results.every((result) => result.body.accepted === true));
  const state = await pool.query<{
    account_usage_rows: string;
    account_units: string;
    user_usage_rows: string;
    user_units: string;
    request_rows: string;
  }>(
    `SELECT
       (SELECT count(*)::text FROM account_usage
        WHERE account_id = $1 AND month = date_trunc('month', now() AT TIME ZONE 'UTC')::date)
         AS account_usage_rows,
       (SELECT units_used::text FROM account_usage
        WHERE account_id = $1 AND month = date_trunc('month', now() AT TIME ZONE 'UTC')::date)
         AS account_units,
       (SELECT count(*)::text FROM user_usage
        WHERE user_id = $2 AND month = date_trunc('month', now() AT TIME ZONE 'UTC')::date)
         AS user_usage_rows,
       (SELECT units_used::text FROM user_usage
        WHERE user_id = $2 AND month = date_trunc('month', now() AT TIME ZONE 'UTC')::date)
         AS user_units,
       (SELECT count(*)::text FROM requests WHERE account_id = $1) AS request_rows`,
    [account.rows[0].id, user.rows[0].id],
  );
  assert.deepEqual(state.rows[0], {
    account_usage_rows: "1",
    account_units: "2",
    user_usage_rows: "1",
    user_units: "2",
    request_rows: "2",
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
  await pool.query(
    `INSERT INTO account_usage (account_id, month, units_used)
     VALUES ($1, date_trunc('month', now() AT TIME ZONE 'UTC')::date, 0)`,
    [account.rows[0].id],
  );
  const blocker = await pool.connect();
  await blocker.query("BEGIN");
  try {
    await blocker.query(
      "SELECT account_id FROM account_usage WHERE account_id = $1 FOR UPDATE",
      [account.rows[0].id],
    );
    const response = await request(
      createApp({
        pool,
        adminApiKey: "a".repeat(32),
        consumeLockTimeoutMs: 100,
        consumeStatementTimeoutMs: 2_000,
      }),
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
    assert.equal(response.headers["retry-after"], "1");
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

  const retried = await request(createApp({ pool, adminApiKey: "a".repeat(32) }))
    .post("/v1/consume")
    .set("X-API-Key", key)
    .send({
      user_id: "busy-timeout-user",
      units: 1,
      request_id: "busy-timeout-request",
    });
  assert.equal(retried.status, 200);
  assert.equal(retried.body.accepted, true);
  assert.equal(retried.body.replayed, false);
  const finalState = await pool.query<{ units: string; requests: string }>(
    `SELECT au.units_used::text AS units,
            (SELECT count(*)::text FROM requests
             WHERE account_id = au.account_id
               AND request_id = 'busy-timeout-request') AS requests
     FROM account_usage au
     WHERE au.account_id = $1
       AND au.month = date_trunc('month', now() AT TIME ZONE 'UTC')::date`,
    [account.rows[0].id],
  );
  assert.deepEqual(finalState.rows[0], { units: "1", requests: "1" });
});

test("statement timeout returns busy and provides a retry delay", {
  skip: !connectionString,
}, async () => {
  const pool = requireTestPool();
  const { starterPlanId, basicPlanId } = requireSeed();
  const key = randomUUID() + randomUUID();
  const account = await pool.query<{ id: string }>(
    `INSERT INTO accounts (name, api_key_hash, plan_id)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [`Statement timeout ${randomUUID()}`, hashApiKey(key), starterPlanId],
  );
  await pool.query(
    `INSERT INTO users (account_id, external_id, plan_id)
     VALUES ($1, 'statement-timeout-user', $2)`,
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
      createApp({
        pool,
        adminApiKey: "a".repeat(32),
        consumeLockTimeoutMs: 2_000,
        consumeStatementTimeoutMs: 50,
      }),
    )
      .post("/v1/consume")
      .set("X-API-Key", key)
      .send({
        user_id: "statement-timeout-user",
        units: 1,
        request_id: "statement-timeout-request",
      });

    assert.equal(response.status, 503);
    assert.equal(response.body.error.code, "busy");
    assert.equal(response.headers["retry-after"], "1");
    assert.equal(
      getConsumeTimeoutCode({ code: "57014" }),
      "57014",
    );
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
  }
});

test("only PostgreSQL lock and statement timeouts map to busy", () => {
  assert.equal(getConsumeTimeoutCode({ code: "55P03" }), "55P03");
  assert.equal(getConsumeTimeoutCode({ code: "57014" }), "57014");
  assert.equal(getConsumeTimeoutCode({ code: "40P01" }), undefined);
  assert.equal(getConsumeTimeoutCode({ code: "23505" }), undefined);
  assert.equal(getConsumeTimeoutCode(new Error("connection failed")), undefined);
  assert.equal(getConsumeTimeoutCode(null), undefined);
});

test("waiting for a pool connection is not charged against consume timeouts", {
  skip: !connectionString,
}, async () => {
  const { starterPlanId, basicPlanId } = requireSeed();
  const options = `-c search_path=${getSchemaName()}`;
  const oneConnectionPool = new Pool({
    connectionString,
    options,
    max: 1,
  });
  const key = randomUUID() + randomUUID();
  try {
    const account = await oneConnectionPool.query<{ id: string }>(
      `INSERT INTO accounts (name, api_key_hash, plan_id)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [`Pool wait ${randomUUID()}`, hashApiKey(key), starterPlanId],
    );
    const user = await oneConnectionPool.query<{ id: string; external_id: string }>(
      `INSERT INTO users (account_id, external_id, plan_id)
       VALUES ($1, $2, $3)
       RETURNING id, external_id`,
      [account.rows[0].id, `pool-wait-${randomUUID()}`, basicPlanId],
    );
    const blocker = await oneConnectionPool.connect();
    const consuming = consume(
      oneConnectionPool,
      {
        accountId: account.rows[0].id,
        userExternalId: user.rows[0].external_id,
        units: 1,
        requestId: "pool-wait-does-not-timeout",
      },
      lockingStrategy,
      { lockTimeoutMs: 25, statementTimeoutMs: 500 },
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    blocker.release();
    const result = await consuming;
    assert.equal(result.accepted, true);
  } finally {
    await oneConnectionPool.end();
  }
});

test("parallel account users and plan assignments complete without deadlocks", {
  skip: !connectionString,
}, async () => {
  const pool = requireTestPool();
  const { starterPlanId, basicPlanId } = requireSeed();
  const key = randomUUID() + randomUUID();
  const account = await pool.query<{ id: string }>(
    `INSERT INTO accounts (name, api_key_hash, plan_id)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [`Plan concurrency account ${randomUUID()}`, hashApiKey(key), starterPlanId],
  );
  const externalIds = Array.from(
    { length: 10 },
    (_, index) => `plan-concurrency-${index}-${randomUUID()}`,
  );
  for (const externalId of externalIds) {
    await pool.query(
      `INSERT INTO users (account_id, external_id, plan_id)
       VALUES ($1, $2, $3)`,
      [account.rows[0].id, externalId, basicPlanId],
    );
  }

  const app = createApp({ pool, adminApiKey: "a".repeat(32) });
  const operations = [
    ...externalIds.map((externalId) =>
      request(app)
        .put(`/v1/users/${encodeURIComponent(externalId)}/plan`)
        .set("X-API-Key", key)
        .send({ plan_id: basicPlanId }),
    ),
    ...externalIds.flatMap((externalId, index) =>
      [0, 1].map((attempt) =>
        request(app)
          .post("/v1/consume")
          .set("X-API-Key", key)
          .send({
            user_id: externalId,
            units: 1,
            request_id: `plan-concurrency-${index}-${attempt}`,
          }),
      ),
    ),
  ];
  const results = await Promise.all(operations);
  assert.ok(results.every((result) => result.status === 200));

  const accounting = await pool.query<{
    account_usage: string;
    accepted_units: string;
    user_usage: string;
  }>(
    `SELECT au.units_used::text AS account_usage,
            COALESCE(SUM(uu.units_used), 0)::text AS user_usage,
            (SELECT COALESCE(SUM(r.units), 0)::text
             FROM requests r
             WHERE r.account_id = a.id AND r.outcome = 'accepted') AS accepted_units
     FROM accounts a
     LEFT JOIN account_usage au
       ON au.account_id = a.id
      AND au.month = date_trunc('month', now() AT TIME ZONE 'UTC')::date
     LEFT JOIN users u ON u.account_id = a.id
     LEFT JOIN user_usage uu
       ON uu.user_id = u.id
      AND uu.month = date_trunc('month', now() AT TIME ZONE 'UTC')::date
     WHERE a.id = $1
     GROUP BY a.id, au.units_used`,
    [account.rows[0].id],
  );
  assert.deepEqual(accounting.rows[0], {
    account_usage: "20",
    accepted_units: "20",
    user_usage: "20",
  });
});

test("consume rejects a user that belongs to a different account", {
  skip: !connectionString,
}, async () => {
  const pool = requireTestPool();
  const { starterPlanId, basicPlanId } = requireSeed();
  const keyA = randomUUID() + randomUUID();
  const keyB = randomUUID() + randomUUID();
  const accountA = await pool.query<{ id: string }>(
    `INSERT INTO accounts (name, api_key_hash, plan_id)
     VALUES ($1, $2, $3) RETURNING id`,
    [`Isolation A ${randomUUID()}`, hashApiKey(keyA), starterPlanId],
  );
  const accountB = await pool.query<{ id: string }>(
    `INSERT INTO accounts (name, api_key_hash, plan_id)
     VALUES ($1, $2, $3) RETURNING id`,
    [`Isolation B ${randomUUID()}`, hashApiKey(keyB), starterPlanId],
  );
  await pool.query(
    `INSERT INTO users (account_id, external_id, plan_id)
     VALUES ($1, 'only-in-b', $2)`,
    [accountB.rows[0].id, basicPlanId],
  );
  const app = createApp({ pool, adminApiKey: "a".repeat(32) });
  const response = await request(app)
    .post("/v1/consume")
    .set("X-API-Key", keyA)
    .send({ user_id: "only-in-b", units: 1, request_id: "cross-account" });
  assert.equal(response.status, 404);

  const claims = await pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM requests WHERE request_id = 'cross-account'",
  );
  assert.equal(claims.rows[0].count, "0");
  const usage = await pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM account_usage WHERE account_id = $1",
    [accountB.rows[0].id],
  );
  assert.equal(usage.rows[0].count, "0");
});
