# Usage Metering and Quota Service

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
- [Database and tests](#database-and-tests)
- [Run the full stack with Docker Compose](#run-the-full-stack-with-docker-compose)
- [Accounts and API keys](#accounts-and-api-keys)
- [Users](#users)
- [Plans and assignments](#plans-and-assignments)
- [Consume units](#consume-units)
- [Usage and request history](#usage-and-request-history)
- [Performance test](#performance-test)
- [Design details](docs/DESIGN.md)

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

The latest recorded full run reports **33 passed, 0 failed, 0 skipped**. The
Compose k6 profile can be run after starting the stack, with workload
variables such as `VUS`, `DURATION`, and `ACCOUNTS` as needed:

```sh
docker compose --profile loadtest run --rm k6 run /scripts/consume.js
```

For the accounting audit after a load test, run:

```sh
docker compose exec -T db psql -U usage_metering -d usage_metering -f /scripts/audit.sql
```

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

The Compose demo is implemented as a small CLI client in `client/demo.mjs`.

## Performance test

The k6 test provisions fresh accounts and users through the API, then sends
concurrent consume requests. `ACCOUNTS=1` stresses the shared account
usage row; using multiple accounts spreads virtual users across independent
account rows. `ALLOWANCE` sets the monthly limit for account and user plans,
`UNITS` sets the amount per request, and `DUP_RATE` controls the fraction of
iterations that resend the previous request ID from the same VU. Consume
counters exclude account/user setup calls. Accepted and rejected counts
represent fresh decisions; replays are counted separately. The summary also
includes `consume_busy` (HTTP 503); busy responses are classified by
`Retry-After` as lock timeout, statement timeout, or unclassified. These
counts appear alongside request rate and p95/p99 latency.
The default configuration checks that every request
is accepted; alternate workload modes validate only a valid 200 decision body
and do not apply the default all-checks threshold.

Run the API and database first with `docker compose up --build`. In another
terminal, run a single-account contention test:

```sh
docker compose run --rm \
  -e VUS=20 \
  -e DURATION=30s \
  -e ACCOUNTS=1 \
  k6 run /scripts/consume.js
```

Then run a spread-across-accounts comparison with the same concurrency and
duration:

```sh
docker compose run --rm \
  -e VUS=20 \
  -e DURATION=30s \
  -e ACCOUNTS=10 \
  k6 run /scripts/consume.js
```

Three further workload examples:

```sh
# Rejection-heavy: 5000-unit shared account allowance
docker compose run --rm -e VUS=20 -e DURATION=30s -e ACCOUNTS=1 \
  -e ALLOWANCE=5000 -e UNITS=1 k6 run /scripts/consume.js

# Replay mix: about 20% of each VU's iterations replay its previous request ID
docker compose run --rm -e VUS=50 -e DURATION=30s -e ACCOUNTS=10 \
  -e DUP_RATE=0.2 k6 run /scripts/consume.js

# 100 distinct users contend for one account's shared usage row
docker compose run --rm -e VUS=100 -e DURATION=30s -e ACCOUNTS=1 \
  k6 run /scripts/consume.js
```

Record the k6 summary's `http_reqs` rate and `http_req_duration` p90/p95 for
each run, along with `consume_requests` rate and `consume_latency` p95/p99. Use
the consume-only metrics for strategy comparisons. Do not compare runs with
different VU counts, duration, account count, or Docker resources. The
default-mode thresholds require all response checks to pass and fewer than 1%
failed HTTP requests. In alternate modes rejections and replays are expected;
503 responses still appear in `consume_busy` and the failed-response count.

### Recorded locking-strategy baseline

Initial local WSL/Docker runs (20 VUs, 30 seconds, 2026-10-17) used the default
locking strategy. The first run was followed by a database accounting query
that returned 0 mismatches. A second run of each account layout showed
noticeable single-account variability. The original k6 summaries did not
include custom consume-only metrics or p99, so these observed `iterations/s`
and `http_req_duration` values are a baseline, not an apples-to-apples result
for the improved strategy. The reported HTTP duration may include setup
requests.

| Accounts | Run | Consume iterations/sec | HTTP duration median | HTTP duration p95 | Max HTTP duration |
|---:|---:|---:|---:|---:|---:|
| 1 | 1 | 359.85 | 55.16 ms | 77.93 ms | 15.17 s |
| 1 | 2 | 258.61 | 68.18 ms | 106.55 ms | 15.18 s |
| 10 | 1 | 694.57 | 25.59 ms | 31.73 ms | 15.12 s |
| 10 | 2 | 713.35 | 26.93 ms | 32.45 ms | 15.12 s |

Across these runs, 10 accounts produced higher throughput than one shared
account, consistent with contention on the account usage row. This is
directional evidence only: local virtualization resources were not recorded,
the single-account result varied, and rare ~15-second requests occurred in all
runs despite much lower p95 latency. These measurements were made with the
normal locking strategy, not the conditional strategy.

### Compare locking and conditional strategies

`CONSUMPTION_STRATEGY` selects `locking` (default) or `conditional` when the API
starts. The conditional path atomically increments the user and account usage
rows only when each monthly allowance has room. If either update cannot apply,
a savepoint rolls back any partial increment and the locking path determines
the exact rejection reason and usage snapshot. Both paths share the same
transactional request claim, plan locks, history write, and replay behavior.

To compare, run the same k6 commands above once with each strategy. In WSL,
recreate the API with the strategy set for that run; k6 creates fresh test data
on every invocation:

```sh
CONSUMPTION_STRATEGY=locking docker compose up -d --build --force-recreate api
# Run the ACCOUNTS=1 and ACCOUNTS=10 k6 commands above.

CONSUMPTION_STRATEGY=conditional docker compose up -d --build --force-recreate api
# Run the same two k6 commands again.
```

After each run, execute the accounting validation query below and record its
result alongside the consume-only throughput and p95/p99 latency.

### Conditional-strategy comparison results

After implementing the conditional path, the same updated k6 script was run
twice per strategy/account layout: 20 VUs, 30 seconds, against the active
Windows/WSL2 Docker Desktop Compose database. The benchmark API was isolated
from the regular API container. Every request was accepted, no HTTP requests
failed, and an accounting audit after all four runs returned 0 mismatches.

| Strategy | Accounts | Consume requests/sec (runs; mean) | Consume p95 (runs) | Consume p99 (runs) |
|---|---:|---:|---:|---:|
| Locking | 1 | 246.01, 229.73; **237.87** | 109.24, 120.20 ms | 131.56, 149.35 ms |
| Conditional | 1 | 261.43, 201.77; **231.60** | 102.19, 138.07 ms | 127.70, 175.59 ms |
| Locking | 10 | 507.32, 469.76; **488.54** | 44.46, 46.80 ms | 55.62, 57.92 ms |
| Conditional | 10 | 511.11, 518.16; **514.63** | 47.21, 42.61 ms | 57.28, 49.82 ms |

With one shared account, conditional throughput averaged about 2.6% lower;
with ten accounts, it averaged about 5.3% higher. Latency percentiles varied
between repeats and do not show a consistent improvement across both
workloads. This short local sample **does not establish that the conditional
strategy is generally faster**. The shared account row remains a serialized
hotspot. Keep `locking` as the default and select `conditional` explicitly
when comparing on another environment. The host CPU/memory allocation was not
recorded, and rare ~15-second requests occurred in every condition despite
p99 values under 180 ms.

The comparison is a small local sample, not a capacity guarantee. Repeat it
with target hardware and Docker resource limits recorded before drawing a
production conclusion.

### Historical pool-50 baseline (before the perf-branch query changes)

To check whether the earlier results were constrained by the default
PostgreSQL client pool, `DB_POOL_MAX=50` was tested against a 12-vCPU,
7.58-GiB Docker Desktop engine. Each setting was run three times for 30
seconds with the same pool and limits, once for each strategy. The following
table reports the mean and min–max spread for consume-only requests/sec and
latency percentiles:

| Strategy | VUs / accounts | Requests/sec mean (range) | p95 ms mean (range) | p99 ms mean (range) |
|---|---:|---:|---:|---:|
| Locking | 20 / 10 | 526.23 (512.41–535.52) | 48.50 (45.18–50.40) | 62.93 (58.21–66.03) |
| Conditional | 20 / 10 | 557.39 (524.10–577.30) | 45.76 (40.27–54.93) | 60.60 (50.58–78.29) |
| Locking | 50 / 10 | 529.28 (507.14–561.87) | 115.36 (111.09–120.26) | 141.41 (137.07–149.08) |
| Conditional | 50 / 10 | 511.80 (509.12–515.39) | 119.56 (118.49–120.27) | 143.14 (138.23–148.70) |
| Locking | 100 / 10 | 498.43 (495.85–500.81) | 228.60 (225.89–230.35) | 296.46 (288.72–307.52) |
| Conditional | 100 / 10 | 496.86 (484.76–503.05) | 227.29 (223.31–234.07) | 310.04 (271.45–369.21) |
| Locking | 100 / 100 | 598.35 (491.10–795.68) | 203.93 (198.09–213.95) | 265.80 (235.39–298.15) |
| Conditional | 100 / 100 | 522.82 (514.80–536.28) | 213.55 (205.68–225.35) | 260.99 (258.10–264.99) |

All 24 runs had 100% accepted requests, 0% failed HTTP requests, and zero
failed k6 checks. A database audit after the full matrix returned **0 usage
mismatches**. Raw per-run consume metrics are in
[`loadtest/results/pool50-benchmarks.csv`](./loadtest/results/pool50-benchmarks.csv);
the individual k6 summary JSON files are generated locally but ignored by Git.

The larger pool coincided with about 7.7% more throughput for the 20-VU,
10-account locking case than the earlier two-run baseline, but these were
separate test sessions, so that difference alone does not prove the pool size
caused the gain. At 50 and 100 VUs with 10 accounts, throughput stayed near
500 requests/sec while p95 latency rose substantially. This indicates a
saturation ceiling in this setup rather than throughput scaling with VUs.
At 100 accounts, the locking average is inflated by one much higher run
(795.68 requests/sec); the other two were 491–508, so the apparent advantage
over conditional is not reliable. Overall, conditional did not give a
consistent advantage as concurrency/accounts increased.

Conditional throughput versus locking was +5.9% at 20 VUs/10 accounts, -3.3%
at 50/10, -0.3% at 100/10, and -12.6% at 100/100. The final comparison is
skewed by the locking outlier above; the two other locking runs were slower
than conditional.

During locking, sampled API CPU averaged 107% and peaked at 130%;
PostgreSQL averaged 284% and peaked at 366%. During conditional, the API
averaged 101% and peaked at 119%; PostgreSQL averaged 272% and peaked at 342%.
Docker reports CPU relative to one core as 100%, so the API was around one
core and Postgres used roughly 2.7–2.8 cores on average. This suggests the
database was the larger CPU consumer, and the 12-vCPU host was not globally
saturated. These are short-interval Docker stats samples, not a hardware
capacity test. Raw per-run benchmark values are in
[`loadtest/results/pool50-benchmarks.csv`](./loadtest/results/pool50-benchmarks.csv);
the Docker stats CSVs and individual k6 summary JSON files are generated
locally but ignored by Git. Repeat CPU observation when benchmarking on the
target machine.

After both runs, check that accepted request units match persisted account and
user usage for the current UTC month. This query must return no rows:

```sh
docker compose exec -T db psql \
  -U usage_metering -d usage_metering -c "
WITH current_month AS (
  SELECT date_trunc('month', transaction_timestamp() AT TIME ZONE 'UTC')::date AS month
)
SELECT 'account' AS level, a.id, COALESCE(u.units_used, 0) AS usage_units,
       COALESCE(SUM(r.units) FILTER (WHERE r.outcome = 'accepted'), 0) AS accepted_units
FROM accounts a
CROSS JOIN current_month m
LEFT JOIN account_usage u ON u.account_id = a.id AND u.month = m.month
LEFT JOIN requests r ON r.account_id = a.id AND r.month = m.month
WHERE a.name = 'Load test account'
GROUP BY a.id, u.units_used
HAVING COALESCE(u.units_used, 0) <>
       COALESCE(SUM(r.units) FILTER (WHERE r.outcome = 'accepted'), 0)
UNION ALL
SELECT 'user' AS level, us.id, COALESCE(u.units_used, 0) AS usage_units,
       COALESCE(SUM(r.units) FILTER (WHERE r.outcome = 'accepted'), 0) AS accepted_units
FROM users us
CROSS JOIN current_month m
LEFT JOIN user_usage u ON u.user_id = us.id AND u.month = m.month
LEFT JOIN requests r ON r.user_id = us.id AND r.month = m.month
WHERE us.external_id LIKE 'load-user-%'
GROUP BY us.id, u.units_used
HAVING COALESCE(u.units_used, 0) <>
       COALESCE(SUM(r.units) FILTER (WHERE r.outcome = 'accepted'), 0);
"
```

Each run creates fresh load-test accounts. For repeatable tests, use a
dedicated Compose project name and remove only that project's database volume
when resetting it, for example `docker compose -p usage-bench down -v`. Do not
run `down -v` against the normal development project unless you intend to
delete its database.

For higher-concurrency tests, `ACCOUNTS` can exceed `VUS`; set both to 100 to
give each virtual user its own account. The script creates one user per
account in that case.

To repeat the scaling matrix, set a larger pool before recreating the API:

```sh
DB_POOL_MAX=50 docker compose up -d --build --force-recreate api
```

Run each pair of settings at least three times with identical strategy, pool
size, duration, and container resource limits:

| VUs | Accounts | Purpose |
|---:|---:|---|
| 20 | 10 | Compare against the earlier 20-VU workload |
| 50 | 10 | Increase concurrency against the same number of account rows |
| 100 | 10 | Stress the database pool and shared account rows |
| 100 | 100 | Reduce account-row contention at 100 VUs |

Change each k6 command's `VUS` and `ACCOUNTS` values accordingly. Set
`CONSUMPTION_STRATEGY=locking` or `conditional` in `.env` and recreate the API
between strategy groups. To watch resource use during each run, open another
terminal and run `docker stats`; observe API CPU, memory, and database CPU.
Record every repeat's consume requests/sec and p95/p99. Report the mean and
range (min–max), not only the best run.

### Consume query-count optimization (perf branch)

PostgreSQL statement logging measured the locking strategy's accepted
transaction at 13 SQL statements before the query changes, 11 after combining
the config/month lookup, 9 on the warm usage-row path after lazy initialization,
and 7 after combining the two usage updates with the accepted request update.
Transaction-local lock and statement timeouts add one statement, so the current
warm accepted path uses 8 SQL statements. The count excludes the API-key
authentication lookup, which runs before the transaction and is skipped on a
warm API-key cache hit. First requests in a new UTC month have extra statements
to create and re-lock the missing user and account usage rows. Rejections do
not run the combined usage CTE and still only write their request decision.
The 7-statement count was verified from PostgreSQL logs before the timeout
configuration was added; 8 is the derived current count, not a fresh log
measurement.

### Measured perf-branch comparison (2026-10-18)

The branch was compared with `main` (`95b80d0`) using `perf` (`93ac0f4`).
Both stacks ran on the same Windows Docker Desktop host (12 CPUs, 7.58 GiB),
with PostgreSQL 16, `DB_POOL_MAX=50`, the same k6 script, and separate fresh
databases. Each profile ran for 30 seconds, three times, with the order
alternated between branches. Both used the locking consumption strategy;
the perf branch used its default-enabled API-key cache. RPS is the k6
consume-request rate, and p95/p99 are consume latency.

| VUs / accounts | Main RPS mean (range) | Perf RPS mean (range) | Change | p95 ms mean (main / perf) | p99 ms mean (main / perf) | HTTP errors (main / perf) |
|---:|---:|---:|---:|---:|---:|---:|
| 20 / 10 | 496.8 (386.0–641.1) | 637.8 (569.6–754.6) | +28.4% | 62.0 / 44.4 | 93.4 / 61.3 | 0 / 0 |
| 50 / 10 | 569.8 (548.5–597.9) | 743.7 (676.4–789.7) | +30.5% | 107.1 / 93.0 | 133.5 / 120.2 | 0 / 57 |
| 100 / 10 | 464.7 (428.0–508.0) | 635.6 (588.2–684.8) | +36.8% | 257.9 / 203.4 | 398.1 / 344.0 | 0 / 65 |
| 100 / 100 | 466.4 (442.0–514.9) | 703.7 (552.4–787.4) | +50.9% | 303.5 / 186.2 | 466.9 / 261.0 | 0 / 0 |

Across the four equally weighted profiles, mean throughput increased from
499.4 to 680.2 requests/sec (+36.2%). The accepted-request rate, excluding
errors, was approximately 499.4 versus 679.9 requests/sec (+36.1%). Perf
outperformed main in all 12 corresponding repeats; gains varied considerably
by profile and run, so these local results are evidence of improvement on this
host, not a general capacity guarantee or a controlled attribution to one
specific code change.

The perf runs had 122 failed responses out of 267,936 attempts (0.046%), all
in the 50-VU/10-account and 100-VU/10-account scenarios. PostgreSQL
lock/statement timeouts are mapped to HTTP 503 `busy`, and the transaction
rolls back; these attempts do not change usage. This causes the k6
all-checks-must-pass threshold to fail for those six perf runs, while main
had no failed responses. After each branch's run, account and user usage
matched accepted-request history with zero mismatches. Treat the improved
throughput together with this small but real fail-fast rate.

### Timeout and pool tuning (2026-10-18)

The earlier implementation used transaction-local `lock_timeout=1000ms` and
`statement_timeout=5000ms`. During the first timeout fix, provisional defaults
were raised to 5000/15000 ms. Both settings are applied with `SET LOCAL` after
`pool.connect()` and `BEGIN`, so waiting for a pool connection is not charged
against either timeout. Only PostgreSQL errors `55P03` (lock timeout) and
`57014` (statement timeout/cancellation) map to HTTP 503 `busy`; other errors
follow the normal error path. A timeout rolls back the transaction and the
request-ID claim. `Retry-After` gives the corresponding configured delay;
clients must retry with the **same request ID, user, and units**.

With `statement_timeout=15000ms`, each lock-timeout setting below was run three
times at each profile against a fresh database. Throughput is the mean and
range; `503s` is the total across the three runs:

| Lock timeout | 50 VUs / 10 accounts RPS (range) | 503s | 100 VUs / 10 accounts RPS (range) | 503s |
|---:|---:|---:|---:|---:|
| 1 s | 594.0 (558.6–613.6) | 58 | 626.0 (568.3–679.9) | 68 |
| 3 s | 651.3 (627.0–672.8) | 52 | 634.2 (616.1–660.3) | 72 |
| 5 s | 688.1 (646.6–733.3) | 57 | 637.2 (612.8–665.2) | 57 |
| 10 s | 799.6 (716.6–841.9) | 57 | 624.9 (618.4–629.2) | 70 |

No lock-timeout value produced zero 503s. A response-classified 50-VU/10-
account run at 1/15 seconds had 18 statement-timeout responses and zero
lock-timeout responses; its maximum consume latency was about 16.8 seconds.
Raising `statement_timeout` to 20 seconds while keeping the lock timeout at
1 second removed 503s in three repeats each at 50/10 and 100/10:

| Profile | Repeats | RPS mean (range) | 503s |
|---|---:|---:|---:|
| 50 VUs / 10 accounts | 3 | 659.0 (647.4–679.0) | 0 |
| 100 VUs / 10 accounts | 3 | 642.1 (618.9–667.8) | 0 |

The more contended 100-VU/one-account case produced one statement-timeout 503
at 20 seconds. Three perf repeats at 30 seconds produced zero 503s, so the
selected defaults are `CONSUME_LOCK_TIMEOUT_MS=1000` and
`CONSUME_STATEMENT_TIMEOUT_MS=30000`. This 30-second value passed the
single-account case and the 10-account profiles; it is still a bounded
fail-safe, not a service-level latency target.

The tests ran on the same 12-vCPU, 7.58-GiB Docker Desktop host with
PostgreSQL 16. The pool comparison used 100 VUs / 10 accounts, 30-second
runs, 1-second lock and 20-second statement timeouts (the settings in effect
during that matrix), and three fresh-database repeats. Pool 100 used
PostgreSQL's default `max_connections=100`; its first audit attempt could not
connect while all
slots were occupied by the API. The three pool-100 runs were repeated with
the API stopped before auditing, and all audits passed:

| `DB_POOL_MAX` | RPS mean (range) | p95 ms mean | p99 ms mean | 503s | Audit mismatches |
|---:|---:|---:|---:|---:|---:|
| 20 | 554.2 (508.5–596.2) | 284.2 | 487.6 | 0 | 0 |
| 50 | 647.1 (639.8–652.8) | 220.5 | 354.5 | 0 | 0 |
| 100 | 628.7 (611.8–647.7) | 308.8 | 472.8 | 0 | 0 |

Pool 50 was best in this setup. A pool of 100 both reduced throughput versus
50 and left no spare connection for the audit/admin client. Keep the combined
pools of all API instances below PostgreSQL's `max_connections`.

The requested additional workloads ran for 30 seconds, three times each,
alternating main and perf on every repeat. All rows below use `DB_POOL_MAX=50`,
locking, and fresh databases. The comparison used 1-second/20-second
lock/statement timeouts on perf; main did not have configurable timeouts. The
final perf default was subsequently raised to a 30-second statement timeout
after the one-account case exposed a single cancellation. RPS and latency
percentiles are mean (range for RPS); decision counts are totals across the
three runs:

| Scenario | Main RPS (range) | Perf RPS (range) | p95 ms (main / perf) | p99 ms (main / perf) | 503s (main / perf) |
|---|---:|---:|---:|---:|---:|
| Rejection-heavy, 20 VUs / 1 account, allowance 5,000 | 270.4 (258.2–284.9) | 298.5 (277.0–319.9) | 276.1 / 232.4 | 488.9 / 494.0 | 0 / 0 |
| Replay mix, 50 VUs / 10 accounts, `DUP_RATE=0.2` | 421.5 (189.8–544.6) | 443.3 (265.2–672.3) | 252.1 / 242.8 | 429.3 / 387.2 | 0 / 0 |
| 100 VUs / 1 account | 124.0 (69.2–225.6) | 231.8 (97.1–309.4) | 2923 / 1451 | 5061 / 2933 | 0 / 1 |

The corresponding accepted / rejected / replayed totals were:

| Scenario | Main | Perf |
|---|---|---|
| Rejection-heavy | 15,000 / 9,334 / 0 | 15,000 / 11,867 / 0 |
| Replay mix | 30,378 / 0 / 7,561 | 31,930 / 0 / 7,971 |
| 100 VUs / 1 account at 20-second statement timeout | 11,164 / 0 / 0 | 20,862 / 0 / 0 |

The perf single-account 503 was the one `57014` statement timeout noted above.
After choosing 30 seconds, the perf 100-VU/one-account profile was repeated
three more times: mean 265.7 requests/sec (208.6–301.1), p95 979.8 ms, p99
1966.5 ms, 23,909 accepted units, 0 rejected/replayed requests, 0 accounting
mismatches, and 0 busy responses. These results remove the timeout seen at
20 seconds but are not a paired main-versus-perf retest.

The rejection-heavy run accepted exactly 5,000 units in each run, with all
further requests rejected and no accounting mismatch. Replay runs recorded
replays separately from fresh accepted decisions. Across all completed audits,
usage matched accepted history and there were no duplicate request IDs or
PostgreSQL `40P01` deadlocks. One Docker CPU snapshot during contention showed
the API at roughly 109–113% of one core; this is not a sustained CPU profile.
Replay throughput varied widely between repeats, so the small mean differences
are not strong evidence of a general speedup. The benchmark measures the
bundle of query, timeout, and cache changes together, not any one change.
The cache benefit is likely flattered by only 10 accounts and a warm
30-second cache; a much larger or churning account population remains
unmeasured.

Raw per-run data is in
[`timeout-lock-matrix.csv`](./loadtest/results/timeout-lock-matrix.csv),
[`timeout-statement-matrix.csv`](./loadtest/results/timeout-statement-matrix.csv),
[`pool-tuning.csv`](./loadtest/results/pool-tuning.csv), and
[`scenario-results.csv`](./loadtest/results/scenario-results.csv), with the
30-second one-account retest in
[`one-account-30s.csv`](./loadtest/results/one-account-30s.csv). The earlier
pool-100 audit connection failures are recorded in
[`pool-tuning-audit-slot.csv`](./loadtest/results/pool-tuning-audit-slot.csv).
The earlier main/perf and locking/conditional CSVs linked below preserve their
own original run data. No sustained 100-VU soak, production-sized account
population, PostgreSQL query profiler, or Node CPU profile was measured.

To reproduce a single matrix cell safely, use the same 30-second k6 command
shown above, set `DB_POOL_MAX`, `CONSUME_LOCK_TIMEOUT_MS`, and
`CONSUME_STATEMENT_TIMEOUT_MS` before starting the API, then repeat it three
times. Reset only the isolated benchmark project between repeats:

```sh
export API_PORT=3301 DB_POOL_MAX=50
export CONSUME_LOCK_TIMEOUT_MS=1000 CONSUME_STATEMENT_TIMEOUT_MS=30000
docker compose -p perf-bench down -v
docker compose -p perf-bench up -d --build api
docker cp loadtest/audit.sql perf-bench-db-1:/tmp/audit.sql
docker compose -p perf-bench --profile loadtest run --rm \
  -e VUS=100 -e DURATION=30s -e ACCOUNTS=10 \
  -e CONSUME_LOCK_TIMEOUT_MS=1000 \
  -e CONSUME_STATEMENT_TIMEOUT_MS=30000 \
  k6 run /scripts/consume.js
docker compose -p perf-bench exec -T db \
  psql -X -U usage_metering -d usage_metering -f /tmp/audit.sql
docker compose -p perf-bench down -v
```

Use a different `-p` name for each branch/project, switch between the exact
main revision (`95b80d0`) and perf, and alternate branches on each repeat. For
the main worktree, copy the current `loadtest/consume.js` and `loadtest/audit.sql`
from perf into the temporary benchmark worktree so both branches use identical
instrumentation; this does not change main's service source. The audit SQL
prints no rows on success. This setup needs Docker Compose v2 and uses the
bundled PostgreSQL 16 and k6 0.55.0 containers; k6 does not need to be installed
on the host.

### Locking versus conditional on the perf branch

The same three-repeat matrix compared the two selectable strategies on the
perf branch:

| VUs / accounts | Locking RPS mean (range) | Conditional RPS mean (range) | Conditional change | HTTP errors (locking / conditional) |
|---:|---:|---:|---:|---:|
| 20 / 10 | 630.7 (594.6–689.4) | 628.2 (617.2–636.7) | −0.4% | 1 / 1 |
| 50 / 10 | 597.5 (506.9–652.1) | 595.7 (556.0–633.0) | −0.3% | 61 / 47 |
| 100 / 10 | 614.8 (609.5–620.6) | 623.7 (587.2–666.2) | +1.5% | 74 / 60 |
| 100 / 100 | 678.0 (650.7–702.8) | 697.4 (657.4–729.0) | +2.9% | 0 / 0 |

The conditional strategy averaged about 1% more throughput overall, with
overlapping run ranges and no consistent per-run win. Keep locking as the
default; the measurements do not justify claiming that conditional is
materially faster.

Raw per-run results are recorded in
[`perf-branch-vs-main.csv`](./loadtest/results/perf-branch-vs-main.csv) and
[`perf-locking-vs-conditional.csv`](./loadtest/results/perf-locking-vs-conditional.csv).
They include accepted counts, failed-response counts, p95/p99, and k6 exit
status. The earlier pool-50 table above predates these query changes and is
not the result of this branch comparison. No PostgreSQL query profiler or
Node CPU profile was collected; Docker CPU readings were snapshots rather
than a sustained profile.

On a warm API-key cache hit, the authentication lookup SQL is also skipped.
This cache is configurable using `API_KEY_CACHE_ENABLED`; its 30-second TTL
trades immediate revocation for lower database work. No key-revocation endpoint
exists, and cache state is local to each API process.

The request indexes were audited against idempotency and history queries; all
four serve a constraint or a query shape, so no index was dropped. Neither
`user_usage.units_used` nor `account_usage.units_used` is indexed. The local
`pg_stat_user_tables` sample showed 9 updates and 9 HOT updates for each usage
table, but this is too small to predict behavior under load. No fillfactor
migration was applied without a before/after workload comparison.

Named prepared statements, pool-size comparisons, benchmark-only PostgreSQL
tuning, and Node CPU profiling were not performed. The measured branch
comparison is end-to-end and does not isolate the speed contribution of each
change. The account usage row remains a structural serialization point for
multiple users in one account.
