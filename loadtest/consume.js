import http from "k6/http";
import { check, fail } from "k6";
import exec from "k6/execution";
import { Counter, Rate, Trend } from "k6/metrics";

const apiUrl = (__ENV.API_URL || "http://localhost:3000/v1").replace(/\/$/, "");
const adminApiKey = __ENV.ADMIN_API_KEY;
const vus = Number(__ENV.VUS || 20);
const duration = __ENV.DURATION || "30s";
const accountCount = Number(__ENV.ACCOUNTS || 1);
const allowance = Number(__ENV.ALLOWANCE ?? 1000000000);
const units = Number(__ENV.UNITS ?? 1);
const duplicateRate = Number(__ENV.DUP_RATE ?? 0);
const lockTimeoutMs = Number(__ENV.CONSUME_LOCK_TIMEOUT_MS ?? 1000);
const statementTimeoutMs = Number(__ENV.CONSUME_STATEMENT_TIMEOUT_MS ?? 30000);
const consumeRequests = new Counter("consume_requests");
const consumeLatency = new Trend("consume_latency", true);
const consumeAccepted = new Rate("consume_accepted");
const consumeAcceptedCount = new Counter("consume_accepted_count");
const consumeRejectedCount = new Counter("consume_rejected_count");
const consumeReplayed = new Counter("consume_replayed");
const consumeBusy = new Counter("consume_busy");
const consumeBusyLockTimeout = new Counter("consume_busy_lock_timeout");
const consumeBusyStatementTimeout = new Counter("consume_busy_statement_timeout");
const consumeBusyUnclassified = new Counter("consume_busy_unclassified");

const defaultMode =
  allowance === 1000000000 && units === 1 && duplicateRate === 0;

if (!adminApiKey || adminApiKey.length < 32) {
  throw new Error("ADMIN_API_KEY must contain at least 32 characters");
}
if (!Number.isInteger(vus) || vus < 1) {
  throw new Error("VUS must be a positive integer");
}
if (!Number.isInteger(accountCount) || accountCount < 1) {
  throw new Error("ACCOUNTS must be a positive integer");
}
if (!Number.isSafeInteger(allowance) || allowance < 0) {
  throw new Error("ALLOWANCE must be a non-negative safe integer");
}
if (!Number.isSafeInteger(units) || units < 1) {
  throw new Error("UNITS must be a positive safe integer");
}
if (!Number.isFinite(duplicateRate) || duplicateRate < 0 || duplicateRate > 1) {
  throw new Error("DUP_RATE must be a number between 0 and 1");
}

export const options = {
  scenarios: {
    consume: {
      executor: "constant-vus",
      vus,
      duration,
    },
  },
  thresholds: defaultMode ? {
    checks: ["rate==1"],
    http_req_failed: ["rate<0.01"],
  } : {},
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
      monthly_allowance: allowance,
      max_per_request: Math.max(units, 1000000),
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
      monthly_allowance: allowance,
      max_per_request: Math.max(units, 1000000),
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
  let requestId;
  const replayPrevious =
    previousRequestId !== undefined && Math.random() < duplicateRate;
  if (replayPrevious) {
    requestId = previousRequestId;
  } else {
    requestId = `load-${__VU}-${exec.scenario.iterationInTest}`;
  }
  previousRequestId = requestId;
  const response = http.post(
    `${apiUrl}/consume`,
    JSON.stringify({
      user_id: externalId,
      units,
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
  if (response.status === 503) {
    consumeBusy.add(1);
    const retryAfter = Number(response.headers["Retry-After"]);
    if (
      Number.isFinite(retryAfter) &&
      Math.ceil(lockTimeoutMs / 1000) !== Math.ceil(statementTimeoutMs / 1000)
    ) {
      if (retryAfter === Math.ceil(lockTimeoutMs / 1000)) {
        consumeBusyLockTimeout.add(1);
      } else if (retryAfter === Math.ceil(statementTimeoutMs / 1000)) {
        consumeBusyStatementTimeout.add(1);
      } else {
        consumeBusyUnclassified.add(1);
      }
    } else {
      consumeBusyUnclassified.add(1);
    }
    consumeAccepted.add(false);
  } else if (response.status === 200) {
    const body = response.json();
    const accepted = body.accepted === true;
    consumeAccepted.add(accepted);
    if (body.replayed === true) {
      consumeReplayed.add(1);
    } else if (accepted) {
      consumeAcceptedCount.add(1);
    } else {
      consumeRejectedCount.add(1);
    }
  } else {
    consumeAccepted.add(false);
  }

  if (defaultMode) {
    check(response, {
      "consume returns HTTP 200": (res) => res.status === 200,
      "consume accepts exactly one unit": (res) =>
        res.status === 200 &&
        res.json("accepted") === true &&
        res.json("replayed") === false,
    });
  } else {
    check(response, {
      "consume returns a decision": (res) => {
        if (res.status !== 200) return false;
        const body = res.json();
        return typeof body.accepted === "boolean";
      },
    });
  }
}

let previousRequestId;
