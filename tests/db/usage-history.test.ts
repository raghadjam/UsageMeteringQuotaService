import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import request from "supertest";
import { createApp } from "../../src/app";
import { hashApiKey } from "../../src/middleware/auth";
import { connectionString, registerDbHooks, requireTestPool } from "./helpers";

registerDbHooks();

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
