import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateConsumption, type ConsumptionPlan } from "../../src/consume/rules";

const accountPlan: ConsumptionPlan = {
  id: "account-plan",
  name: "Account",
  monthly_allowance: 20,
  max_per_request: 10,
};
const userPlan: ConsumptionPlan = {
  id: "user-plan",
  name: "User",
  monthly_allowance: 12,
  max_per_request: 5,
};

test("consume rejects in the specified account/user rule order", () => {
  const userPerRequest = evaluateConsumption(
    11,
    { user: 0, account: 0 },
    accountPlan,
    userPlan,
  );
  assert.deepEqual(userPerRequest.rejected_by, {
    level: "user",
    rule: "per_request",
  });

  const accountPerRequest = evaluateConsumption(
    8,
    { user: 0, account: 0 },
    { ...accountPlan, max_per_request: 7 },
    userPlan,
  );
  assert.deepEqual(accountPerRequest.rejected_by, {
    level: "account",
    rule: "per_request",
  });

  const userMonthly = evaluateConsumption(
    2,
    { user: 11, account: 0 },
    accountPlan,
    userPlan,
  );
  assert.deepEqual(userMonthly.rejected_by, {
    level: "user",
    rule: "monthly_allowance",
  });

  const accountMonthly = evaluateConsumption(
    2,
    { user: 0, account: 19 },
    accountPlan,
    userPlan,
  );
  assert.deepEqual(accountMonthly.rejected_by, {
    level: "account",
    rule: "monthly_allowance",
  });
});

test("accepted decisions expose plan limits and clamp remaining units at zero", () => {
  const decision = evaluateConsumption(
    2,
    { user: 3, account: 8 },
    accountPlan,
    userPlan,
  );
  assert.equal(decision.accepted, true);
  assert.equal(decision.account.plan, "Account");
  assert.equal(decision.account.monthly_allowance, 20);
  assert.equal(decision.account.max_per_request, 10);
  assert.equal(decision.user.remaining, 9);

  const loweredPlan = evaluateConsumption(
    1,
    { user: Number.MAX_SAFE_INTEGER, account: 0 },
    accountPlan,
    { ...userPlan, monthly_allowance: 1 },
  );
  assert.equal(loweredPlan.accepted, false);
  assert.equal(loweredPlan.user.remaining, 0);
});
