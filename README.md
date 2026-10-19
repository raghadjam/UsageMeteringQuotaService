# Usage Metering and Quota Service

![CI](https://github.com/raghadjam/UsageMeteringQuotaService/actions/workflows/ci.yml/badge.svg)

Backend service for recording usage and enforcing account-level and user-level
quotas. Accounts, users, custom plans, plan assignments, and transactional
consumption with idempotent request history are implemented.

An account owns registered users and has an account plan; each user also has a
user plan. A consume request must fit both plans' per-request and monthly
limits. Accepted usage is recorded once in PostgreSQL, and the saved decision
can be replayed safely with the caller's request ID.

## Quick start

Copy `.env.example` to `.env`, then run `docker compose up --build`. Compose
starts PostgreSQL 16 and the API, waits for health checks, and runs the
dependency-free Node demo client. The client creates a demo account and
demonstrates accepted and rejected requests and plan changes. The API is at
`http://localhost:3000/v1`; check `http://localhost:3000/v1/health` for
readiness. Never commit `.env` or real credentials.

## Contents

- [Quick start](#quick-start)
- [Diagrams](#diagrams)
- [Predefined plans and rules](#predefined-plans-and-rules)
- [Testing](#testing)
- [Run the service without Docker](#run-the-service-without-docker)
- [Run the full stack with Docker Compose](#run-the-full-stack-with-docker-compose)
- [Accounts and API keys](#accounts-and-api-keys)
- [Users](#users)
- [Plans and assignments](#plans-and-assignments)
- [Consume units](#consume-units)
- [Usage and request history](#usage-and-request-history)
- [Performance test](#performance-test)
- [Design details](#design-details)
  - [Product assumptions](#product-assumptions)
  - [Design decisions and tradeoffs](#design-decisions-and-tradeoffs)
  - [Known limitations](#known-limitations)
  - [Retry behavior](#retry-behavior)
  - [Plan changes](#plan-changes)

## Diagrams

The architecture at a glance:

```mermaid
flowchart LR
    subgraph Compose[Docker Compose]
        Demo[demo-client: client/demo.mjs]
        API[Express API]
        DB[(PostgreSQL 16)]
        K6[k6 load test profile]
        Demo -->|HTTP walkthrough| API
        K6 -->|HTTP traffic| API
        API -->|SQL / migrations| DB
        K6 -.->|audit SQL| DB
    end
    Admin[Admin caller] -->|POST /v1/accounts| API
    Client[Account client] -->|API key| Auth[Auth and 30s key cache]
    Auth --> Validate[Validation]
    Validate --> Routes[Routes]
    Routes --> Services[Services]
    Routes --> Consume[Consume service]
    Routes -. errors .-> ErrorHandler[Central error handler]
    Consume -. errors .-> ErrorHandler
    Consume --> Rules[rules.ts]
    Consume --> Strategy{Strategy}
    Strategy -->|default| Lock[Locking]
    Strategy -->|optional| Conditional[Conditional]
    Lock --> DB
    Conditional --> DB
```

See [the schema, consume sequence, rules, and idempotency diagrams](docs/diagrams.md).

## Predefined plans and rules

| Plan | Kind | Monthly allowance | Max per request |
|---|---|---:|---:|
| Starter | account | 1,000 | 100 |
| Pro | account | 100,000 | 1,000 |
| Basic | user | 100 | 20 |
| Premium | user | 1,000 | 100 |

Each request must pass the per-request limit and monthly allowance at both the
user and account levels. Rejections follow this fixed order: user per-request,
account per-request, user monthly, account monthly. Remaining is
`max(0, limit - used)`; accepted usage increments both levels, while rejected
usage changes neither.

## Testing

Use Node 22 or newer for local development. Run `npm test` with PostgreSQL
available and `TEST_DATABASE_URL` set for the database integration tests. For
example, start PostgreSQL 16 in Docker with a host port:

```powershell
docker run --rm -d --name usage-metering-test-db `
  -e POSTGRES_USER=usage_metering `
  -e POSTGRES_PASSWORD=test_password `
  -e POSTGRES_DB=usage_metering `
  -p 5432:5432 postgres:16-alpine
$env:TEST_DATABASE_URL = "postgres://usage_metering:test_password@localhost:5432/usage_metering"
npm test
```

The latest recorded full run reports **33 passed, 0 failed, 0 skipped**. Set
`TEST_DATABASE_URL` so the database tests run; skipped database tests do not
count as a passing full run. Require zero skipped tests when checking the full
suite.

For the accounting audit after a load test, run:

```sh
docker compose exec -T db psql -U usage_metering -d usage_metering -f /scripts/audit.sql
```

## Run the full stack with Docker Compose

Prerequisites: Docker Desktop (or Docker Engine) with the Compose plugin.
Compose starts PostgreSQL and the API, waits for both health checks, then runs
the example CLI client. The client creates an account, demonstrates acceptance
and user/account quota rejections, changes the plans, and demonstrates that the
same kind of request is accepted after the changes.

```powershell
Copy-Item .env.example .env
# Optional: edit .env to replace the local-only passwords and admin key.
docker compose up --build
```

The API is available at `http://localhost:3000`; PostgreSQL is kept in the
`postgres_data` named volume. The demo client exits when its walkthrough
finishes, while the database and API stay running. It creates a new demo
account on each run. Run the walkthrough again with:

```powershell
docker compose run --rm demo-client
```

Check service readiness at `http://localhost:3000/v1/health`. Stop the stack
while preserving database contents with `docker compose down`. To also remove
the local database and all its data, run `docker compose down -v`.

Compose reads `.env` automatically. Its default keys and passwords are only
for local development; replace them before exposing the service. If you change
the database name, username, or password, update the corresponding values in
`.env` together. Keep the password URI-safe for the Compose-built
`DATABASE_URL`.

`DB_POOL_MAX` controls the maximum PostgreSQL connections in the API pool
(default 50, allowed range 1–100). Set it in `.env` before starting/recreating
the API. Keep the combined pool sizes of all API instances below PostgreSQL's
`max_connections`.

`CONSUME_LOCK_TIMEOUT_MS` and `CONSUME_STATEMENT_TIMEOUT_MS` set transaction-
local PostgreSQL timeouts for consume requests (defaults 1000 ms and 30000 ms;
allowed ranges 1–60000 ms and 1–120000 ms). The service acquires a
pool connection before starting the transaction, so pool-queue time is not
charged against either timeout. PostgreSQL lock timeout (`55P03`) and statement
timeout (`57014`) errors alone map to HTTP 503 `busy`, with a `Retry-After`
header; other database errors retain the regular internal-error behavior. These
defaults were selected from repeated contention tests; the measurements are
summarized below.

If consume returns `503 busy`, the transaction has rolled back, including the
request-ID claim and any usage changes. Retry with the **same `request_id`**,
user, and units. A successful retry processes it normally; retrying after a
committed response replays the stored decision. Do not generate a new ID merely
because the service asked the caller to retry.

`API_KEY_CACHE_ENABLED` enables the in-memory account-key lookup cache
(default `true`; set to `false` to disable). Successful lookups are cached by
API-key hash for 30 seconds, up to 10,000 entries per API process. Cache hits
skip the authentication lookup query; consume still reads the current account
and plans inside its transaction. There is no API-key revocation endpoint, so
a key replaced or invalidated directly in PostgreSQL may remain accepted by
an API process for up to 30 seconds. Separate replicas have separate caches.

## Run the service without Docker

Set `DATABASE_URL` and an admin secret of at least 32 characters:

```powershell
$env:DATABASE_URL = "postgres://postgres:YOUR_PASSWORD@localhost:5432/usage_metering"
$env:ADMIN_API_KEY = "replace-with-a-random-secret-at-least-32-characters"
npm run dev
```

The server applies pending migrations on startup. For a separate migration run,
install dependencies and run `npm run db:migrate` with `DATABASE_URL` set.

Set `DATABASE_URL` and `ADMIN_API_KEY` in your shell as above. Do not commit
real credentials.

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
For database integration test setup, see [Testing](#testing).

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

The Compose demo is implemented as a small CLI client in `client/demo.mjs`.

## Design details

### Product assumptions

The service meters one resource in whole-number units against the UTC calendar
month. A quota rejection is a final decision returned as HTTP 200; see the
[product assumptions](docs/DESIGN.md#11-product-assumptions).

### Design decisions and tradeoffs

PostgreSQL transactions make the usage changes and request decision atomic.
The shared account usage row serializes requests for users in that account;
the [design notes](docs/DESIGN.md#12-design-decisions-and-tradeoffs) explain
why this is favored over approximate counters and other alternatives.

### Known limitations

This is a single-PostgreSQL service. Pool wait is outside the consume timeout,
and API-key cache entries can delay direct database key revocation by up to 30
seconds. See [known limitations](docs/DESIGN.md#13-known-limitations).

### Retry behavior

`request_id` is idempotent per account. Same ID, user, and units replay the
saved decision; changed input returns 409. On 503 `busy`, retry the same ID,
user, and units because the transaction and claim were rolled back. See
[failure scenarios](docs/DESIGN.md#10-failure-scenarios).

### Plan changes

Edits and switches apply to the next request and preserve accumulated usage.
If the allowance falls below usage, remaining is zero and further requests
will be rejected at that level. See [plan changes](docs/DESIGN.md#8-plan-changes).

## Performance test

**Performance summary**

- Main-versus-perf mean throughput: 499.4 to 680.2 consume requests/sec (+36.2%).
- At 100 VUs on one account, mean throughput was about 1.9x higher (231.8 vs 124.0 requests/sec).
- The shared account usage row remains the bottleneck under single-account contention.
- Current app defaults: `CONSUME_LOCK_TIMEOUT_MS=1000`, `CONSUME_STATEMENT_TIMEOUT_MS=30000`; pool 50 performed best in the tested matrix.
- The warm accepted path fell from 13 to 8 transaction SQL statements, including the timeout-setting statement.
- Completed audits reported zero accounting mismatches; database logs showed zero deadlocks.
- Conditional strategy showed no reliable gain over locking; locking remains the default.
- Caveat: the benchmark measures a bundle of changes together, on one local machine; the 30-second key cache was flattered by a small, warm account population.

Run a 30-second, one-account smoke load test after starting the Compose stack:

```sh
docker compose --profile loadtest run --rm -e VUS=20 -e DURATION=30s -e ACCOUNTS=1 k6 run /scripts/consume.js
```

See [Performance results and load testing](docs/PERFORMANCE.md) for workload options, methodology, historical benchmark tables, and raw CSV links.
