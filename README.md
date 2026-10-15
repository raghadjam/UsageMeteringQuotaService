# Usage Metering and Quota Service

Backend service for recording usage and enforcing account-level and user-level
quotas. Accounts, users, custom plans, plan assignments, and transactional
consumption with idempotent request history are implemented.

## Database and tests

PostgreSQL migrations create the plan, account, user, usage, and request-history
tables, enforce their core relationships, and seed the
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

## Users

Register users with an account API key. `external_id` is the caller's stable
identifier; `plan_id` is optional and defaults to Basic. Users may be assigned a
predefined user plan or a custom user plan created by the same account.

```sh
curl -X POST http://localhost:3000/v1/users \
  -H "Content-Type: application/json" \
  -H "X-API-Key: <account-api-key>" \
  -d '{"external_id":"sara-42"}'
```

List users with cursor pagination (default 50, maximum 200 per page), or fetch a
single user by external ID. Every query is scoped to the account identified by
the API key; a user belonging to a different account returns 404.

```sh
curl "http://localhost:3000/v1/users?limit=50" \
  -H "X-API-Key: <account-api-key>"
curl "http://localhost:3000/v1/users/sara-42" \
  -H "X-API-Key: <account-api-key>"
```

The user list uses a stable `(created_at, id)` cursor and an account-scoped
database index. Duplicate external IDs within one account return 409; the same
external ID may be used by another account.

## Plans and assignments

List the predefined plans and the authenticated account's custom plans. Filter
by kind with `?kind=account` or `?kind=user`. A custom plan is visible only to
the account that created it.

```sh
curl "http://localhost:3000/v1/plans?kind=user" \
  -H "X-API-Key: <account-api-key>"
```

Create account- or user-level custom plans, then update a custom plan with
`PATCH /v1/plans/:id`. Predefined plans are read-only; attempts to update them
or access another account's custom plan return 404. Names are unique within
their owner and plan kind.

```sh
curl -X POST http://localhost:3000/v1/plans \
  -H "Content-Type: application/json" \
  -H "X-API-Key: <account-api-key>" \
  -d '{"kind":"user","name":"Writer","monthly_allowance":500,"max_per_request":40}'
```

Assign an account plan with `PUT /v1/account/plan` or a user plan with
`PUT /v1/users/:externalId/plan`, each accepting `{"plan_id":"<uuid>"}`.
Assignments accept predefined plans or plans owned by that account, and only
plans of the matching kind. Plan edits and switches preserve accumulated usage;
the changed plan limits are returned by subsequent account/user reads.

## Consume units

Call `POST /v1/consume` with the account API key, a registered `user_id`, a
positive whole-number `units` value, and a caller-generated `request_id`:

```sh
curl -X POST http://localhost:3000/v1/consume \
  -H "Content-Type: application/json" \
  -H "X-API-Key: <account-api-key>" \
  -d '{"user_id":"sara-42","units":10,"request_id":"document-123"}'
```

The service evaluates limits in a fixed order: user per-request, account
per-request, user monthly allowance, then account monthly allowance. A
successful response is `200` and contains `accepted: true`; a quota rejection
is also `200`, with `accepted: false` and a `rejected_by` level and rule.
Responses include the plan snapshots and consumed/remaining monthly units for
both levels.

Requests are processed against the database clock's UTC calendar month. A
rejection consumes no units. Accepted requests increment account and user
totals atomically, and request outcomes are stored in PostgreSQL. The pair
`(account, request_id)` is idempotent: retrying the same user and units returns
the original decision with `replayed: true`; reusing the ID with different
input returns 409. Account and user plan changes synchronize with consumption,
so requests starting after a change commits see the new limits. Usage already
consumed is retained if a limit is reduced or a plan is switched.

## Usage and request history

Read account-wide and per-user totals for the current UTC month, or select a
past month with `?month=YYYY-MM`. The account total is shared across its users.
Past-month responses report consumed units and return `remaining: null`, because
remaining allowance is meaningful only against the currently applied plans.
The account and user plan objects show the limits currently applied; each
request history entry retains the plan/limit snapshot that was used to decide
that request.

```sh
curl "http://localhost:3000/v1/usage?month=2026-10" \
  -H "X-API-Key: <account-api-key>"
curl "http://localhost:3000/v1/users/sara-42/usage?month=2026-10" \
  -H "X-API-Key: <account-api-key>"
```

List request outcomes using cursor pagination (default 50, maximum 200).
Optional filters are `user_id` (the account's external user ID), `month`, and
`outcome=accepted|rejected`. History is always scoped to the API-key account.

```sh
curl "http://localhost:3000/v1/requests?user_id=sara-42&month=2026-10&limit=50" \
  -H "X-API-Key: <account-api-key>"
```

History pages include the stored decision snapshot, rejection level/rule,
request ID, and timestamp. Replaying a request does not add another history
entry.

The example client, Docker Compose, and performance tests remain to be
implemented.
