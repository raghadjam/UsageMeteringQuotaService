import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { after, before } from "node:test";
import { Pool } from "pg";
import { runMigrations } from "../../src/db/migrate";

export const connectionString = process.env.TEST_DATABASE_URL;
export const migrationDirectory = path.join(__dirname, "../../src/db/migrations");

let adminPool: Pool | undefined;
let testPool: Pool | undefined;
let schemaName: string | undefined;
let seed: {
  starterPlanId: string;
  basicPlanId: string;
  accountId: string;
  userId: string;
} | undefined;

export function requireTestPool(): Pool {
  if (!testPool) {
    throw new Error("The database test schema was not initialized");
  }
  return testPool;
}

export function requireSeed(): NonNullable<typeof seed> {
  if (!seed) {
    throw new Error("The database test fixtures were not initialized");
  }
  return seed;
}

export function getSchemaName(): string {
  if (!schemaName) throw new Error("The database test schema was not initialized");
  return schemaName;
}

export function registerDbHooks(): void {
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
}
