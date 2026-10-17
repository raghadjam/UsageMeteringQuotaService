import http from "k6/http";
import { check, fail } from "k6";
import exec from "k6/execution";
import { Counter, Rate, Trend } from "k6/metrics";

const apiUrl = (__ENV.API_URL || "http://localhost:3000/v1").replace(/\/$/, "");
const adminApiKey = __ENV.ADMIN_API_KEY;
const vus = Number(__ENV.VUS || 20);
const duration = __ENV.DURATION || "30s";
const accountCount = Number(__ENV.ACCOUNTS || 1);
const consumeRequests = new Counter("consume_requests");
const consumeLatency = new Trend("consume_latency", true);
const consumeAccepted = new Rate("consume_accepted");

if (!adminApiKey || adminApiKey.length < 32) {
  throw new Error("ADMIN_API_KEY must contain at least 32 characters");
}
if (!Number.isInteger(vus) || vus < 1) {
  throw new Error("VUS must be a positive integer");
}
if (!Number.isInteger(accountCount) || accountCount < 1) {
  throw new Error("ACCOUNTS must be a positive integer");
}

export const options = {
  scenarios: {
    consume: {
      executor: "constant-vus",
      vus,
      duration,
    },
  },
  thresholds: {
    checks: ["rate==1"],
    http_req_failed: ["rate<0.01"],
  },
  summaryTrendStats: ["avg", "min", "med", "max", "p(90)", "p(95)", "p(99)"],
  tags: {
    workload: accountCount === 1 ? "single_account" : "multiple_accounts",
  },
};

function send(method, path, apiKey, body, expectedStatus) {
  const headers = {};
  if (apiKey) headers["X-API-Key"] = apiKey;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (path === "/accounts") headers["X-Admin-API-Key"] = adminApiKey;

  const response = http.request(
    method,
    `${apiUrl}${path}`,
    body === undefined ? null : JSON.stringify(body),
    { headers },
  );
  if (response.status !== expectedStatus) {
    fail(`${method} ${path}: expected HTTP ${expectedStatus}, got ${response.status}: ${response.body}`);
  }
  return response.json();
}

function createAccount() {
  const account = send(
    "POST",
    "/accounts",
    undefined,
    { name: "Load test account" },
    201,
  );
  if (!account.api_key) fail("Account creation did not return an API key");

  const accountPlan = send(
    "POST",
    "/plans",
    account.api_key,
    {
      kind: "account",
      name: "Load test account plan",
      monthly_allowance: 1000000000,
      max_per_request: 1000000,
    },
    201,
  ).plan;
  send(
    "PUT",
    "/account/plan",
    account.api_key,
    { plan_id: accountPlan.id },
    200,
  );

  const userPlan = send(
    "POST",
    "/plans",
    account.api_key,
    {
      kind: "user",
      name: "Load test user plan",
      monthly_allowance: 1000000000,
      max_per_request: 1000000,
    },
    201,
  ).plan;

  return { apiKey: account.api_key, userPlanId: userPlan.id };
}

export function setup() {
  const usersPerAccount = Math.max(1, Math.ceil(vus / accountCount));
  const accounts = [];

  for (let accountIndex = 0; accountIndex < accountCount; accountIndex += 1) {
    const account = createAccount();
    account.users = [];

    for (let userIndex = 0; userIndex < usersPerAccount; userIndex += 1) {
      const externalId = `load-user-${userIndex}`;
      send(
        "POST",
        "/users",
        account.apiKey,
        { external_id: externalId, plan_id: account.userPlanId },
        201,
      );
      account.users.push(externalId);
    }
    accounts.push(account);
  }

  return { accounts, usersPerAccount };
}

export default function ({ accounts, usersPerAccount }) {
  const accountIndex = (__VU - 1) % accountCount;
  const userIndex = Math.floor((__VU - 1) / accountCount) % usersPerAccount;
  const account = accounts[accountIndex];
  const externalId = account.users[userIndex];
  const requestId = `load-${__VU}-${exec.scenario.iterationInTest}`;
  const response = http.post(
    `${apiUrl}/consume`,
    JSON.stringify({
      user_id: externalId,
      units: 1,
      request_id: requestId,
    }),
    {
      headers: {
        "X-API-Key": account.apiKey,
        "Content-Type": "application/json",
      },
    },
  );
  consumeRequests.add(1);
  consumeLatency.add(response.timings.duration);
  consumeAccepted.add(response.status === 200 && response.json("accepted") === true);

  check(response, {
    "consume returns HTTP 200": (res) => res.status === 200,
    "consume accepts exactly one unit": (res) =>
      res.status === 200 && res.json("accepted") === true,
  });
}
