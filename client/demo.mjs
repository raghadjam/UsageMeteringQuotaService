import { randomUUID } from "node:crypto";

const apiUrl = (process.env.API_URL ?? "http://localhost:3000/v1").replace(/\/$/, "");
const adminApiKey = process.env.ADMIN_API_KEY;

if (!adminApiKey || adminApiKey.length < 32) {
  throw new Error("ADMIN_API_KEY must contain at least 32 characters");
}

async function call(path, { method = "GET", apiKey, body } = {}) {
  const headers = {};
  if (apiKey) headers["X-API-Key"] = apiKey;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (path === "/accounts") headers["X-Admin-API-Key"] = adminApiKey;

  const response = await fetch(`${apiUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(`${method} ${path} returned ${response.status}: ${JSON.stringify(result)}`);
  }
  return result;
}

async function consume(apiKey, userId, units, label) {
  const result = await call("/consume", {
    method: "POST",
    apiKey,
    body: { user_id: userId, units, request_id: randomUUID() },
  });
  console.log(`${label}: ${JSON.stringify(result)}`);
  return result;
}

const account = await call("/accounts", {
  method: "POST",
  body: { name: `Compose demo ${randomUUID()}` },
});
const apiKey = account.api_key;
console.log(`Created demo account "${account.name}" on the ${account.plan.name} plan.`);

const { plans: predefinedUserPlans } = await call("/plans?kind=user", { apiKey });
const basicPlan = predefinedUserPlans.find((plan) => plan.name === "Basic");
const premiumPlan = predefinedUserPlans.find((plan) => plan.name === "Premium");
if (!basicPlan || !premiumPlan) {
  throw new Error("The predefined Basic and Premium user plans must exist");
}

await call("/users", {
  method: "POST",
  apiKey,
  body: { external_id: "sara", plan_id: basicPlan.id },
});
await call("/users", {
  method: "POST",
  apiKey,
  body: { external_id: "alex", plan_id: premiumPlan.id },
});

const { plan: sharedCapPlan } = await call("/plans", {
  method: "POST",
  apiKey,
  body: {
    kind: "account",
    name: "Demo shared cap",
    monthly_allowance: 15,
    max_per_request: 100,
  },
});
await call("/account/plan", {
  method: "PUT",
  apiKey,
  body: { plan_id: sharedCapPlan.id },
});

const accepted = await consume(apiKey, "sara", 10, "Basic user, 10 units");
if (!accepted.accepted) throw new Error("Expected the first request to be accepted");

const userRejected = await consume(apiKey, "sara", 21, "Basic user, 21 units");
if (
  userRejected.accepted ||
  userRejected.rejected_by?.level !== "user" ||
  userRejected.rejected_by?.rule !== "per_request"
) {
  throw new Error("Expected the Basic user's per-request limit to reject 21 units");
}

const accountRejected = await consume(apiKey, "alex", 6, "Premium user, 6 units");
if (
  accountRejected.accepted ||
  accountRejected.rejected_by?.level !== "account" ||
  accountRejected.rejected_by?.rule !== "monthly_allowance"
) {
  throw new Error("Expected the shared account allowance to reject 6 units");
}

await call(`/plans/${sharedCapPlan.id}`, {
  method: "PATCH",
  apiKey,
  body: { monthly_allowance: 1000 },
});
await call("/users/sara/plan", {
  method: "PUT",
  apiKey,
  body: { plan_id: premiumPlan.id },
});

const afterPlanChange = await consume(apiKey, "sara", 21, "Sara after plan changes");
if (!afterPlanChange.accepted) {
  throw new Error("Expected Sara's request to be accepted after the plan changes");
}

const usage = await call("/usage", { apiKey });
const history = await call("/requests", { apiKey });
console.log(`Final usage: ${JSON.stringify(usage)}`);
console.log(`Request history: ${JSON.stringify(history)}`);
console.log("Demo completed successfully.");
