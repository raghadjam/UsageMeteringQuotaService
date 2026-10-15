# Usage Metering and Quota Service: Design

Status: implementation in progress. The initial schema, repeatable migration runner, predefined plan seed, account creation, account API-key authentication, account-scoped user management, custom plan management, and plan assignments are implemented. Other sections marked `TODO` remain open. Sections 11 and 12 are written as a first pass and should be rewritten in your own words, because you will be asked about them.

## 1. Overview

A backend service that other applications call before doing something costly. The caller asks "can this user consume N units?", and the service checks the account's plan and the user's plan together, records the decision, and counts the usage if the request is accepted. It does the accounting and the decision, not the actual work.

Stack: Node (current LTS), TypeScript, Express 5, Zod for validation, `pg` with plain SQL, PostgreSQL. Tests use Vitest and supertest against a real Postgres. Load tests use k6.

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

The strategy contract: given the transaction, account, user, units and month, return `{ accepted: true }` or `{ accepted: false, level, rule }`. The shared code builds the response and writes the record, so both strategies produce identical output. The strategy is chosen by a config value.

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

TODO: ER diagram in `docs/`.

TODO: when the daily allowance is added, the usage tables get a period kind (`month` or `day`) in the key. Decide the exact shape at that point.

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
| 403 | Trying to edit a predefined plan |
| 404 | Unknown user or plan, or one that belongs to another account |
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
2. Open a transaction. The month comes from the database clock, in UTC, taken at transaction start.
3. Claim the request: insert (account_id, request_id, user, units) with `ON CONFLICT DO NOTHING`.
4. If the insert did nothing, the ID is already claimed. Read the stored row. Same user and units: return the stored decision with `replayed: true`. Different user or units: return 409.
5. Make sure this month's usage rows exist (insert with `ON CONFLICT DO NOTHING`, units_used = 0).
6. Call the locking strategy: check the rules and update the usage rows. The
   account and user rows are held with shared locks to synchronize with plan
   edits and assignments; usage lock order is always user first, then account.
7. Write the outcome and the decision JSON to the request row, commit.
8. Respond.

A crash or error before commit rolls back everything, including the claimed ID, so a retry starts clean. No `isProcessed` flag is needed because the whole decision is one database transaction. A flag would be needed only if processing involved external side effects.

TODO: sequence diagram in `docs/`.

## 7. Rules

| Rule | Level | Meaning |
|---|---|---|
| Monthly allowance | account and user | Total units in a UTC calendar month |
| Max per request | account and user | Largest amount in a single request |
| Daily allowance | account and user (planned) | Total units in a UTC day. Empty means no daily cap. Built last, after the core works |

Rejection order when several rules fail: user per-request, account per-request,
user monthly, account monthly, user daily, account daily. Implemented rules use
the first four checks; daily allowance remains planned.

Remaining is `max(0, limit - used)` and never negative. A request must pass every rule at both levels. A rejection consumes nothing at either level.

TODO: confirm how the daily allowance appears in `remaining` (the lower of the daily and monthly remainders is my suggestion).

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

Different requests competing for the last units: the baseline strategy locks the
user usage row, then the account usage row, with `FOR NO KEY UPDATE`, reads both,
checks the rules, and updates. Fixed lock order prevents deadlocks. The account
row is the known hot spot, since every user in the account updates it. Plan
edits and assignments lock the account row exclusively, while consumption holds
a shared account lock, making each request observe a consistent committed plan.

Optimization: a second strategy that skips the separate read and uses a conditional update (`UPDATE ... SET used = used + n WHERE used + n <= limit`) and checks the row count. A savepoint undoes the user increment if the account update fails, so the request record is still kept. The load test compares both strategies, so the README has a measured before-and-after.

Other levers if needed: keep transactions short, lower fillfactor on the usage tables, collapse the decision into fewer round trips.

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

Load test plan: k6, run from its Docker image. Two scenarios: many users under one account (worst case contention) and users spread across many accounts (no contention). Record throughput, p50 and p99 latency, and accepted versus rejected counts. After every run, check correctness: usage totals must equal the sum of accepted units.

TODO: connection pool size (must not be smaller than the test's concurrency, or queueing will hide the database result).
TODO: lock timeout value, and the error code and status for a request that times out (suggestion: 503 with code `busy`).

## 10. Failure scenarios

| Scenario | Behavior |
|---|---|
| Service crashes mid-transaction | Rolls back, including the claimed request ID. A retry runs fresh |
| Duplicate arrives while the first is processing | Waits on the unique constraint, then replays the stored decision |
| Plan edited during a request | The request uses the plan it read under its locks, and the edit applies to the next one. Never half-applied |
| Retry after a month rollover | Replays the stored decision from the original month, no recount |
| Same request ID, different user or units | 409, nothing changes |
| Lock wait too long | TODO |
| Database unavailable | TODO |

## 11. Product assumptions (draft)

1. A rejected request is final. Retrying the same ID replays the rejection. To try again, use a new ID.
2. The same request ID with a different user or units is a caller bug and returns 409.
3. A request belongs to the UTC month in which its transaction started, using the database clock.
4. Request IDs are unique per account, not globally.
5. Past months report consumed units only. `remaining` is computed only for the current month, against current limits.
6. A user or plan belonging to another account returns 404, so existence is not revealed.
7. A business rejection returns 200 with `accepted: false`. Error statuses are for broken requests, so clients that auto-retry 4xx or 429 do not hammer the service.
8. Predefined plans have no daily allowance. The numbers below are examples.
9. API keys are random, shown once, and stored only as a hash.
10. Units and plan limits are capped at `Number.MAX_SAFE_INTEGER` (`9007199254740991`). The API uses JSON numbers, so accepting larger integers could silently lose precision in JavaScript. PostgreSQL stores them as `BIGINT`, and the schema enforces the same bound.

## 12. Design decisions and tradeoffs (draft)

Write each in your own words.

**Insert-first idempotency, no isProcessed flag.** The challenge is two identical requests at once. Claiming the ID as the first step inside the transaction makes the database serialize them. Gained: units are counted once, nothing stuck after a crash, no "in progress" state for callers. Traded: a duplicate waits briefly while the first finishes.

**Row locking baseline, conditional update optimization.** The challenge is two requests racing for the last units. Locking is exact and easy to trace, and it makes the reason for a rejection easy to report. Gained: correctness and explainability. Traded: lock held across several round trips, which the conditional strategy reduces.

**Usage rows instead of summing history.** Reading a stored total is instant and gives a row to lock. Traded: two writes per accepted request, both committed with the history row.

**Plans as columns, referenced by ID.** Edits take effect immediately without a redeploy. Traded: adding rules means adding columns, acceptable for two required rules plus the daily allowance.

**JSON decision snapshot on request rows.** Replays are exact and past rejections stay explainable after a plan changes. Traded: values inside the JSON are not indexed, so queryable fields stay as plain columns.

**Plan ownership checked in service code.** One function, one test. Traded: direct database writes could bypass it (listed under limitations). Plan kind is enforced by the database.

**Rejections return 200.** A decision is a normal answer, not an error. Traded: callers must read the `accepted` field.

## 13. Known limitations

- A single Postgres means one account's throughput is capped by its hot usage row. The measured ceiling goes here after the load test (TODO).
- Direct database writes could bypass the plan ownership check.
- Past-month `remaining` is not reported.
- TODO: add more after testing.

## 14. Test plan

- API key validation: missing, invalid, valid
- Account isolation: another account's users, plans and requests return 404
- Replay and conflict: same ID returns the stored decision, different payload returns 409
- 20 identical requests in parallel: usage increases once, one row exists, all responses match
- Many users racing for the last units of an account: totals never exceed the limit
- Plan changes mid-month: usage preserved, reduced allowance shows remaining 0, history unchanged
- Month rollover: new month starts at zero, old months still queryable
- Both strategies produce identical decisions on the same scenarios
- Daily allowance, including the midnight UTC boundary (if built)

## 15. Predefined plans and the demo

| Plan | Kind | Monthly allowance | Max per request |
|---|---|---|---|
| Starter | account | 1,000 | 100 |
| Pro | account | 100,000 | 1,000 |
| Basic | user | 100 | 20 |
| Premium | user | 1,000 | 100 |

Premium's monthly allowance equals Starter's, so one Premium user can use up the whole account allowance. That makes an account-level rejection possible while the user's own limits are fine.

Example client scenario, with account Acme on Starter, Sara on Basic and Omar on Premium:

1. Sara consumes 10. Accepted.
2. Sara consumes 25. Rejected by her per-request limit (20), though both monthly allowances have room.
3. Omar consumes 100 nine times, with nine different request IDs. All accepted. Account usage is 910, Omar's is 900.
4. Omar consumes 100 again. His own limits allow it, but the account has only 90 left. Rejected by the account monthly allowance.
5. The client switches Acme to Pro through the API. Omar sends 100 with a new request ID. Accepted. The client code is unchanged.
6. Optionally switch Sara to Premium and a 25-unit request is accepted.

Step 5 uses a new ID because replaying the rejected ID would return the stored rejection.

## 16. Open questions

- TODO: lock timeout, pool size
- TODO: exact bodies for the plan and user endpoints
- TODO: confirm the daily allowance is in scope after the core is working
