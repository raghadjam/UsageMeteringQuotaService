# Usage Metering and Quota Service: Design

Status: the required service, Compose demo, automated tests, and reproducible performance benchmark are implemented. The locking and conditional strategies are selectable. Local benchmark results and limitations are documented in the README; they do not show a consistent performance win for the conditional strategy.

## 1. Overview

A backend service that other applications call before doing something costly. The caller asks "can this user consume N units?", and the service checks the account's plan and the user's plan together, records the decision, and counts the usage if the request is accepted. It does the accounting and the decision, not the actual work.

Stack: Node (current LTS), TypeScript, Express 5, Zod for validation, `pg` with plain SQL, PostgreSQL. Tests use the Node test runner and supertest against PostgreSQL. Load tests use k6.

Out of scope, per the brief: billing, payments, refunds, multiple resource types, end-user login, role-based permissions, distributed infrastructure.

## 2. Glossary

| Term | Meaning |
|---|---|
| Account | An application or company calling the service. Has an API key and an account plan. |
| User | A user of that application, registered under an account. Has a user plan. |
| Plan | A named set of rules. Predefined plans are read-only. Custom plans belong to one account. |
| Units | The amount consumed by one action. One resource only. |
| Usage row | A stored running total of units used by one user (or one account) in one UTC month. |
| Request | One consume call, identified by the caller's request ID, unique per account. |

## 3. Architecture and code layout

Routes validate input and call a service. Services hold the rules (plan ownership, read-only plans) and call queries. The consume module is self-contained and has two interchangeable strategies.

```
src/
  app.ts                 builds the Express app
  server.ts              starts it, graceful shutdown
  config.ts              env vars, strategy switch
  errors.ts              AppError types
  routes/                accounts, plans, users, consume, usage, requests, health
  middleware/            auth, validate, errorHandler
  services/              accountService, planService, userService, usageService
  consume/
    consumeService.ts    shared flow: claim ID, replay, record, respond
    strategy.ts          the interface
    lockingStrategy.ts   baseline: row locks
    conditionalStrategy.ts  optimization: conditional updates
    rules.ts             per-request checks, rejection order
  db/
    pool.ts
    migrate.ts
    migrations/          numbered .sql files
    queries/             one file per area
tests/
client/                  example CLI
loadtest/                k6 scripts and results
docs/                    this file, diagrams
```

The strategy contract: given the transaction, account, user, units and month, return a decision and usage-write directive. The locking strategy returns final user/account totals for the shared accepted-write statement; the conditional strategy may report that it already applied usage inside its savepoint. Rejections carry no usage write. The service stores the immutable request decision, and both paths are tested for decision parity. The strategy is chosen by a config value.

## 4. Data model

| Table | Holds |
|---|---|
| plans | kind (`account` or `user`), owner account (empty for predefined), name, monthly_allowance, max_per_request |
| accounts | name, api_key_hash, plan_id + plan_kind |
| users | account_id, external_id (the caller's own identifier), plan_id + plan_kind |
| user_usage | user_id, month, units_used. Primary key (user_id, month) |
| account_usage | account_id, month, units_used. Primary key (account_id, month). The hot row. |
| requests | the history, never edited after commit (columns below) |

Constraints the database enforces:

- plans: unique (id, kind). Name unique per owner and kind. Allowance 0 or more, max per request 1 or more.
- accounts and users reference plans through (plan_id, plan_kind), with a check that the kind is `account` for accounts and `user` for users.
- users: unique (account_id, external_id). Unique (id, account_id) so requests can prove a user belongs to the account.
- usage tables: `units_used` is 0 or more.
- requests: unique (account_id, request_id). Units positive. Foreign key (user_id, account_id) to users(id, account_id).
- Plans referenced by an account or user cannot be deleted (restrict).

Month is stored as a date, the first day of the UTC month (for example `2026-10-01`).

Requests table columns:

| Column | Notes |
|---|---|
| id | primary key |
| account_id, request_id | unique pair, the idempotency claim |
| user_id | with account_id, points at users |
| units | positive |
| month | the UTC month the request was processed in |
| outcome | `accepted` or `rejected` |
| rejected_level, rejected_rule | `account` or `user`, and the rule name. Empty if accepted |
| decision | JSON snapshot of the full response, including plan IDs and the limits applied |
| created_at | |

`outcome` and `decision` are nullable because the claim insert happens first and the update happens later. Both occur in one transaction, so no committed row has them empty. Plain columns exist for everything the history endpoint filters on. The JSON column makes replays exact and survives plan edits.

Plan ownership (a custom plan must belong to the same account) is enforced in service code and covered by tests. Plan kind is enforced by the database.

Account API keys contain 256 random bits, are returned only at account creation, and are stored as SHA-256 hashes. Hashing is appropriate here because randomly generated keys have high entropy and cannot feasibly be recovered from their digest.

An ER diagram is omitted; the tables and relationships are described above and defined by the SQL migration.

## 5. API

All endpoints are under `/v1` and use JSON. Callers send `X-API-Key`. The service hashes it and looks up the account. A missing or unknown key returns 401 with the same response in both cases. `POST /accounts` is protected by an admin key from the environment (`ADMIN_API_KEY`).

| Area | Endpoint | Purpose |
|---|---|---|
| Accounts | `POST /accounts` (admin key) | Create an account, returns the API key once |
| | `GET /account` | Own account with current plan and limits |
| | `PUT /account/plan` | Switch the account plan |
| Plans | `GET /plans` | Predefined plus own custom plans, filter by kind |
| | `POST /plans` | Create a custom plan |
| | `GET /plans/:id` | View one plan |
| | `PATCH /plans/:id` | Update a custom plan |
| Users | `POST /users` | Register a user with an external ID and optional plan |
| | `GET /users` | List users, paginated |
| | `GET /users/:externalId` | One user with plan and limits |
| | `PUT /users/:externalId/plan` | Switch the user plan |
| Consume | `POST /consume` | The core decision |
| Usage | `GET /usage?month=2026-10` | Account totals and each user's consumed and remaining |
| | `GET /users/:externalId/usage?month=` | One user's usage |
| History | `GET /requests` | Paginated outcomes, filter by user, month, outcome |
| Ops | `GET /health` | For Docker Compose |

There is no plan deletion endpoint, because the brief does not ask for it.

Consume request:

```json
{ "user_id": "sara-42", "units": 25, "request_id": "doc-7731" }
```

Consume response (rejected by a user limit):

```json
{
  "request_id": "doc-7731",
  "accepted": false,
  "replayed": false,
  "rejected_by": { "level": "user", "rule": "per_request" },
  "user":    { "plan": "Basic", "used": 40, "remaining": 960, "max_per_request": 20 },
  "account": { "plan": "Starter", "used": 95, "remaining": 905, "max_per_request": 100 }
}
```

An accepted request has the same shape with `accepted: true` and no `rejected_by`.

| Status | When |
|---|---|
| 200 / 201 | Success (201 for creates). A rejected consume is also 200. |
| 400 | Invalid body: units not a positive integer, missing request ID, bad month format |
| 401 | Missing or invalid API key |
| 404 | Unknown or inaccessible resource, including unknown users/plans, cross-account resources, and predefined plans on update |
| 409 | Request ID reused with a different user or units, duplicate user external ID, duplicate plan name |

Errors share one shape: `{ "error": { "code": "request_id_conflict", "message": "..." } }`. The `code` is for programs, the message is for humans.

Pagination is cursor-based on (created_at, id), with `limit` (default 50, max 200) and `next_cursor` in the response.

Usage month is an optional UTC calendar month (`YYYY-MM`); omitting it selects
the database's current UTC month. Account usage includes each registered user's
usage for the selected month. `remaining` is returned for the current month
only; historical usage returns `remaining: null`. The displayed plan is the
plan currently assigned, while request history contains the immutable plan and
limit snapshot captured when each decision was made.

Request history accepts optional `user_id` (external user ID), `month`, and
`outcome=accepted|rejected` filters. History pagination is newest-first using
the stable `(created_at, id)` cursor; each result includes the persisted
decision JSON and rejection details.

User registration accepts `{ "external_id": "sara-42", "plan_id": "<optional-user-plan-uuid>" }`. The plan must be predefined or owned by the authenticated account; it defaults to Basic. `GET /users` accepts a cursor and a limit from 1 to 200 (default 50) and returns `next_cursor`.

Custom plan creation accepts `{ "kind": "user", "name": "Writer", "monthly_allowance": 500, "max_per_request": 40 }`; updates accept a non-empty subset of `name`, `monthly_allowance`, and `max_per_request`. `PUT /account/plan` and `PUT /users/:externalId/plan` accept `{ "plan_id": "<uuid>" }`. Both assignment endpoints validate kind and ownership and preserve existing usage.

## 6. Consume flow

1. Authenticate the key and validate the input.
2. Open a transaction and set transaction-local `lock_timeout` to 1 second and
   `statement_timeout` to 5 seconds. The month comes from the database clock,
   in UTC, taken at transaction start.
3. Claim the request: insert (account_id, request_id, user, units) with `ON CONFLICT DO NOTHING`.
4. If the insert did nothing, the ID is already claimed. Read the stored row. Same user and units: return the stored decision with `replayed: true`. Different user or units: return 409.
5. Call the configured strategy. The locking path locks the user usage row
   first and creates/re-locks it only if missing, then does the same for the
   account usage row. This keeps initialization off the steady-state path.
6. For an accepted locking-strategy decision, one data-modifying CTE writes
   both final usage totals and the request decision. Rejections write only the
   request outcome. The conditional strategy keeps its savepoint-based usage
   updates and then writes the request decision.
7. Commit.
8. Respond.

A crash or error before commit rolls back everything, including the claimed ID, so a retry starts clean. No `isProcessed` flag is needed because the whole decision is one database transaction. A flag would be needed only if processing involved external side effects.

The sequence is described above; a separate sequence diagram is omitted.

## 7. Rules

| Rule | Level | Meaning |
|---|---|---|
| Monthly allowance | account and user | Total units in a UTC calendar month |
| Max per request | account and user | Largest amount in a single request |

Rejection order when several rules fail: user per-request, account per-request,
user monthly, then account monthly.

Remaining is `max(0, limit - used)` and never negative. A request must pass every rule at both levels. A rejection consumes nothing at either level.

## 8. Plan changes

- Edits and switches apply to the next request after the update commits.
- Plans are referenced by ID and limits are read at request time, so no redeploy is needed.
- Switching a plan keeps usage already consumed this month. It does not grant a fresh allowance.
- If an allowance is reduced below existing usage, remaining shows 0 and further consumption at that level is rejected until allowance is available again.
- Past requests keep their own snapshot, so history is unaffected by later edits.
- Predefined plans are read-only. A custom plan can only be assigned inside the account that owns it.
- A new account without a chosen plan gets Starter. A new user without a chosen plan gets Basic.

## 9. Concurrency and performance

Same request ID arriving at the same instant: the unique constraint on (account_id, request_id) makes the second insert wait for the first transaction. After the first commits, the second sees the conflict and replays the stored decision. Units are counted once.

Different requests competing for the last units: the locking strategy locks the
user usage row, then the account usage row, with `FOR NO KEY UPDATE`, reads both,
and checks the rules. It creates missing monthly rows lazily while retaining
that user-then-account order. For accepted decisions, one data-modifying CTE
writes the final user total, account total, and request outcome/decision
together; a missing row or request makes the transaction fail and roll back.
Fixed lock order prevents deadlocks. The account row is the known hot spot,
since every user in the account updates it. Plan edits and assignments lock the
account row exclusively, while consumption holds a shared account lock, making
each request observe a consistent committed plan.

The selectable conditional strategy skips the separate usage reads on accepted requests. It conditionally increments the user row, then the account row, checking each affected-row result. Both updates happen after a savepoint. If either allowance is exhausted, rollback to the savepoint undoes any partial increment, then the locking strategy obtains a consistent usage snapshot and returns the exact rejection. This retains the user-then-account lock order. Its accepted usage updates remain separate from the request decision write; only the locking strategy uses the combined CTE. `CONSUMPTION_STRATEGY=locking|conditional` selects the implementation at service startup. PostgreSQL integration tests cover concurrent account and user monthly limits, concurrent duplicate IDs, and decision parity between strategies. Historical benchmark results did not establish a consistent performance improvement; the current query-count changes have not been load-tested in this environment. See the README.

For the locking strategy, the measured accepted-request transaction count is
13 statements before the query reductions, 11 after merging the config lookup,
9 on the warm usage-row path after lazy initialization, and 7 after combining
the accepted writes. The transaction-local timeout settings add one statement,
so the current warm accepted path is 8 SQL statements. The warm count excludes
API-key authentication, which is outside the transaction and is skipped on an
API-key cache hit. A first request in a new UTC month has additional
lock/insert/re-lock statements for the missing user and account usage rows.
These are statement-count measurements, not evidence of higher throughput.

The API pool size is configurable with `DB_POOL_MAX` (default 50, allowed 1–100). Pool size alone does not remove contention on an account's shared usage row. Further query and transaction tuning should be guided by profiling.

Successful account-key lookups are cached per API process as SHA-256 key hash
to account ID for 30 seconds, with a 10,000-entry LRU cap. This avoids the auth
lookup SQL on cache hits; consume still reads the account and current plans
inside its transaction. `API_KEY_CACHE_ENABLED=false` disables the cache. There
is no API-key revocation endpoint, so a key replaced or invalidated directly
in the database can remain accepted by that process for up to 30 seconds.
Each API replica has an independent cache.

Request-index audit (the indexes are defined on `requests` in migration
`001_initial_schema.sql`):

| Index | Required use |
|---|---|
| `requests_pkey` on `id` | Enforces unique request-row identity; the history API returns `id` as part of its stable cursor. |
| `requests_account_request_id_unique` on `(account_id, request_id)` | `claimRequest` idempotency conflict detection and `findRequest` replay/conflict lookup. |
| `requests_account_created_idx` on `(account_id, created_at DESC, id DESC)` | `listRequestHistory` account scope, newest-first ordering, and `(created_at, id)` cursor pagination. |
| `requests_account_user_month_idx` on `(account_id, user_id, month)` | `listRequestHistory` account/user/month filtering; observed index scans in PostgreSQL statistics. |

The small local database did not exercise the account-created index in its
planner statistics, but it directly supports the history ordering/pagination
shape. No request index was dropped: the remaining indexes enforce a schema
constraint or support idempotency/history queries. Therefore no new index
migration was justified by this audit.

Rejected alternatives, one line each:

| Option | Why rejected |
|---|---|
| Sharded counters | Strict limits need a rebalance near the limit, and requests get wrongly rejected when one shard runs dry |
| Leasing / batching | Totals become approximate, and a crash loses leased allowance |
| In-memory or Redis counters | Not durable, extra infrastructure, two sources of truth |
| Optimistic versioning | Conflicts are frequent on a shared row, so it causes retry storms |
| SERIALIZABLE with retries | Unpredictable latency, harder to explain and tune |
| Advisory lock per account | Same hold time as row locking with no benefit |
| Append-only ledger with SUM | Does not remove the race and gets slower as history grows |

The pool-50 benchmark matrix and earlier baseline are recorded in the README. The matrix used 20, 50, and 100 VUs, 10 or 100 accounts, and three repeats per configuration. The accounting audit found no mismatches. Results showed throughput flattening near 500 requests/second for the tested 10-account cases as VUs increased; the conditional strategy did not consistently outperform locking. Docker CPU samples showed PostgreSQL using more CPU than the API, without saturating the 12-vCPU host. These are local measurements, not a capacity guarantee.

The k6 script measures consume-only throughput and p95/p99 latency, apart from account/user provisioning. Reproducible commands, per-run CSV, results, and caveats are in the README.

## 10. Failure scenarios

| Scenario | Behavior |
|---|---|
| Service crashes mid-transaction | Rolls back, including the claimed request ID. A retry runs fresh |
| Duplicate arrives while the first is processing | Waits on the unique constraint, then replays the stored decision |
| Plan edited during a request | The request uses the plan it read under its locks, and the edit applies to the next one. Never half-applied |
| Retry after a month rollover | Replays the stored decision from the original month, no recount |
| Same request ID, different user or units | 409, nothing changes |
| Consume lock or statement timeout | Rolls back the transaction and returns HTTP 503 with error code `busy`; caller can retry with the same request ID. |
| Database unavailable | Requests surface an internal server error; the health endpoint returns an error and Docker marks the API unhealthy. |

## 11. Product assumptions

1. A rejected request is final. Retrying the same ID replays the rejection. To try again, use a new ID.
2. The same request ID with a different user or units is a caller bug and returns 409.
3. A request belongs to the UTC month in which its transaction started, using the database clock.
4. Request IDs are unique per account, not globally.
5. Past months report consumed units only. `remaining` is computed only for the current month, against current limits.
6. A user or plan belonging to another account returns 404, so existence is not revealed.
7. A business rejection returns 200 with `accepted: false`; callers should inspect that field rather than treating every 200 response as accepted.
8. The service meters one resource, in whole-number units.
9. API keys are random, shown once, and stored only as a hash.
10. Units and plan limits are capped at `Number.MAX_SAFE_INTEGER` (`9007199254740991`). The API uses JSON numbers, so accepting larger integers could silently lose precision in JavaScript. PostgreSQL stores them as `BIGINT`, and the schema enforces the same bound.

## 12. Design decisions and tradeoffs

**Insert-first idempotency, no isProcessed flag.** The challenge is two identical requests at once. Claiming the ID as the first step inside the transaction makes the database serialize them. Gained: units are counted once, nothing stuck after a crash, no "in progress" state for callers. Traded: a duplicate waits briefly while the first finishes.

**Row locking baseline, conditional update alternative.** The locking strategy is the default because it is straightforward and returns precise rejection reasons. Conditional updates try to reduce reads on accepted requests while retaining transactionality; failed conditional updates roll back to a savepoint and use locking to classify the rejection. The local benchmark did not establish a consistent speed advantage, so the alternative remains opt-in.

**Usage rows instead of summing history.** Reading a stored total is instant and gives a row to lock. Traded: two writes per accepted request, both committed with the history row.

**Plans as columns, referenced by ID.** Edits take effect immediately without a redeploy. Adding a new rule type would require extending the schema and evaluation logic.

**JSON decision snapshot on request rows.** Replays are exact and past rejections stay explainable after a plan changes. Traded: values inside the JSON are not indexed, so queryable fields stay as plain columns.

**Plan ownership checked in service code.** One function, one test. Traded: direct database writes could bypass it (listed under limitations). Plan kind is enforced by the database.

**Rejections return 200.** A decision is a normal answer, not an error. Traded: callers must read the `accepted` field.

## 13. Known limitations

- A single Postgres means an account's shared usage row is a serialization point. Local benchmarks show throughput flattening under higher concurrency; results are specific to the tested machine and are not a capacity guarantee.
- Direct database writes could bypass the plan ownership check.
- Past-month `remaining` is not reported.
- Database-unavailable errors still use the generic internal-error response; only consume lock/statement timeouts are mapped to `busy`.

## 14. Verification coverage

Automated tests cover API key validation and cache behavior, account isolation, a 20-request concurrent duplicate storm, idempotent replay and conflict, concurrent quota enforcement, plan changes, timeout rollback/response behavior, and decision parity between both consumption strategies. The previously recorded k6 matrix exercises concurrent accepted requests; a database audit compares stored usage against accepted request history. Performance results for the current query changes remain unmeasured in this environment.

## 15. Predefined plans and the demo

| Plan | Kind | Monthly allowance | Max per request |
|---|---|---|---|
| Starter | account | 1,000 | 100 |
| Pro | account | 100,000 | 1,000 |
| Basic | user | 100 | 20 |
| Premium | user | 1,000 | 100 |

Premium's monthly allowance equals Starter's, so one Premium user can use up the whole account allowance. That makes an account-level rejection possible while the user's own limits are fine.

The runnable Compose client creates users on different plans, demonstrates accepted and rejected consumption, changes plan limits, and demonstrates the effect without changing the consume request. See the README's Compose instructions for how to run it.

## 16. Follow-up considerations

- Consider an explicit lock timeout and documented retryable response if deployment requirements call for bounded lock waits.
- Profile database queries and transaction timings before attempting further performance changes.
- If a new quota rule is required, define its period, reset behavior, decision order, schema, history snapshot, and response semantics before implementing it.
