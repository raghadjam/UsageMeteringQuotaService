# Usage Metering and Quota Service

Backend service for recording usage and enforcing account-level and user-level
quotas. The database foundation, account creation, and API-key authentication
are implemented; remaining API behavior is being built in milestones.

## Database foundation

The initial PostgreSQL migration creates the plan, account, user, usage, and
request-history tables, enforces their core relationships, and seeds the
Starter, Pro, Basic, and Premium plans. It requires PostgreSQL 13 or newer.
Applying migrations repeatedly is safe. Units and plan limits are bounded by
`9007199254740991` (`Number.MAX_SAFE_INTEGER`) to keep JSON integer values exact.

The service applies pending migrations when it starts. To apply them separately,
copy `.env.example` to `.env`, configure `DATABASE_URL`, then run:

```sh
npm install
npm run db:migrate
```

Use `npm test` for the HTTP validation tests and database integration tests.
Without `TEST_DATABASE_URL`, database integration tests are reported as skipped.

To run the schema integration tests, set `TEST_DATABASE_URL` to a PostgreSQL
database where the test role can create and drop schemas. The tests create an
isolated temporary schema and remove it after the run:

```sh
npm run test:db
```

## Run the service

Set `DATABASE_URL` and an admin secret of at least 32 characters:

```powershell
$env:DATABASE_URL = "postgres://postgres:YOUR_PASSWORD@localhost:5432/usage_metering"
$env:ADMIN_API_KEY = "replace-with-a-random-secret-at-least-32-characters"
npm run dev
```

Copy `.env.example` to `.env` and replace the sample credentials for local
development. Do not commit real credentials.

`npm start` runs the compiled server after `npm run build`. The service listens
on port 3000 by default; set `PORT` to change it.

## Accounts and API keys

Create accounts using the admin-only endpoint. The generated account API key is
returned once and is never stored in plaintext; save it securely:

```sh
curl -X POST http://localhost:3000/v1/accounts \
  -H "Content-Type: application/json" \
  -H "X-Admin-API-Key: replace-with-a-random-secret-at-least-32-characters" \
  -d '{"name":"Acme"}'
```

Use the returned `api_key` as `X-API-Key` for that account's endpoints:

```sh
curl http://localhost:3000/v1/account \
  -H "X-API-Key: <account-api-key>"
```

Account creation currently assigns the predefined Starter account plan. The
`POST /v1/accounts` endpoint is protected by `ADMIN_API_KEY`; all requests to
`/v1/account` are scoped to the account identified by `X-API-Key`. Missing and
invalid keys return the same 401 response.

Zod validates account request bodies. API key authentication is database-backed.
Integration tests use a temporary schema in a PostgreSQL database where the test
role can create and drop schemas:

```sh
TEST_DATABASE_URL="postgres://postgres:password@localhost:5432/usage_metering" npm run test:db
```

The user, plan-management, consume, history, client, Docker Compose, and
performance-test features remain to be implemented.
