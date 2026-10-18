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
concurrent one-unit consume requests. `ACCOUNTS=1` stresses the shared account
usage row; using multiple accounts spreads virtual users across independent
account rows. Each load-test account and user receives a high custom limit so
the benchmark measures successful consumption and database contention instead
of exhausting a quota. `consume_requests` and `consume_latency` report consume
traffic only, excluding setup calls. The summary also reports accepted rate,
HTTP errors, and latency percentiles through p99.

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

Record the k6 summary's `http_reqs` rate and `http_req_duration` p90/p95 for
each run, along with `consume_requests` rate and `consume_latency` p95/p99. Use
the consume-only metrics for strategy comparisons. Do not compare runs with
different VU counts, duration, account count, or Docker resources. The
thresholds require all response checks to pass and fewer than 1% failed HTTP
requests; latency is measured, not given a machine-independent pass threshold.

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

### Pool-50 concurrency scaling results

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

Each run creates fresh load-test accounts. Remove the local benchmark data only
when you are ready to delete the whole Compose database volume:
`docker compose down -v`.

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

These are query-count results only. Throughput, p95/p99, pool-size comparisons,
pg_stat_statements profiles, rejection-heavy and same-account/many-user
scenarios, and Docker CPU samples have not been measured for these changes.
Docker and k6 were unavailable in the implementation environment. Do not infer
a throughput win from fewer SQL statements; repeat the matrix above in the
benchmark environment and append those measurements to a separate CSV before
making a performance claim.

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

Named prepared statements, pool-size comparisons at 20/50/100, benchmark-only
PostgreSQL tuning, and Node CPU profiling were not performed. No post-change
throughput-results CSV was created because there are no valid post-change load
measurements. The historical pool-50 table above is not a post-change result.
Fewer statements and auth-cache hits are the verified reductions; throughput
gain and the remaining bottleneck for the optimized code are unmeasured. The
account usage row remains a structural serialization point for multiple users
in one account.
