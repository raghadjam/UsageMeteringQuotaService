import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Pool } from "pg";
import request from "supertest";
import { createApp } from "../../src/app";

const adminApiKey = "local-test-admin-key".padEnd(32, "!");
const pool = new Pool({
  connectionString: "postgres://unused:unused@127.0.0.1:1/unused",
  connectionTimeoutMillis: 50,
});
const app = createApp({ pool, adminApiKey });

after(async () => {
  await pool.end();
});

test("account creation requires the admin API key", async () => {
  const missing = await request(app)
    .post("/v1/accounts")
    .send({ name: "Acme" });
  const invalid = await request(app)
    .post("/v1/accounts")
    .set("X-Admin-API-Key", "incorrect-admin-key".padEnd(32, "!"))
    .send({ name: "Acme" });

  assert.equal(missing.status, 401);
  assert.equal(invalid.status, 401);
  assert.deepEqual(missing.body, invalid.body);
});

test("account creation validates a strict JSON body", async () => {
  const blankName = await request(app)
    .post("/v1/accounts")
    .set("X-Admin-API-Key", adminApiKey)
    .send({ name: "  " });
  assert.equal(blankName.status, 400);
  assert.equal(blankName.body.error.code, "invalid_request");

  const extraProperty = await request(app)
    .post("/v1/accounts")
    .set("X-Admin-API-Key", adminApiKey)
    .send({ name: "Acme", plan_id: "caller-selected-plan" });
  assert.equal(extraProperty.status, 400);
  assert.equal(extraProperty.body.error.code, "invalid_request");
});

test("invalid JSON is reported as a client error", async () => {
  const response = await request(app)
    .post("/v1/accounts")
    .set("X-Admin-API-Key", adminApiKey)
    .set("Content-Type", "application/json")
    .send("{");

  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, "invalid_json");
});
