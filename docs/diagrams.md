# Usage Metering and Quota Service diagrams

These diagrams describe the migrations and runtime flow in this checkout. The
database enforces the relationships, types of limits, and idempotency key
shape; custom-plan ownership is additionally checked by service code.

## Data model

```mermaid
erDiagram
    plans {
        uuid id PK
        text kind "account or user"
        uuid owner_account_id FK "nullable for predefined plans"
        text name
        bigint monthly_allowance
        bigint max_per_request
    }
    accounts {
        uuid id PK
        text name
        text api_key_hash UK
        uuid plan_id FK
        text plan_kind "account"
    }
    users {
        uuid id PK
        uuid account_id FK
        text external_id
        uuid plan_id FK
        text plan_kind "user"
    }
    account_usage {
        uuid account_id PK, FK
        date month PK "first day of UTC month"
        bigint units_used
    }
    user_usage {
        uuid user_id PK, FK
        date month PK "first day of UTC month"
        bigint units_used
    }
    requests {
        uuid id PK
        uuid account_id FK
        uuid user_id FK
        text request_id
        bigint units
        date month "first day of UTC month"
        text outcome
        text rejected_level
        text rejected_rule
        jsonb decision "object snapshot"
    }
    plans ||--o{ accounts : "assigned by id and kind"
    accounts ||--o{ users : owns
    plans ||--o{ users : "assigned by id and kind"
    accounts ||--o{ plans : "owns custom plans"
    accounts ||--o{ account_usage : tracks
    users ||--o{ user_usage : tracks
    accounts ||--o{ requests : scopes
    users ||--o{ requests : attributed_to
```

Usage primary keys are `(account_id, month)` and `(user_id, month)`; unique
constraints cover `(id, kind)`, plan names within their owner scope,
`(account_id, external_id)`, and `(account_id, request_id)`, while a composite
`(user_id, account_id)` foreign key guarantees request ownership. Database
checks enforce plan kind, numeric bounds, first-of-month dates, valid decision
state, and `RESTRICT` deletion of referenced plans and users. `owner_account_id`
is nullable for predefined plans, while same-account custom-plan ownership is
checked in service code.

## Architecture and runtime boundaries

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
        K6 -.->|audit SQL mounted read-only| DB
    end
    Admin[Admin caller] -->|POST /v1/accounts| API
    Client[Account application] -->|X-API-Key requests| Auth[Auth middleware<br/>30s API-key cache]
    Auth --> Validate[Validation middleware]
    Validate --> Routes[Express routes]
    Routes --> Services[Account, user, plan,<br/>usage and request services]
    Routes --> Consume[Consume module]
    Routes -. errors .-> ErrorHandler[Central error handler]
    Services -. errors .-> ErrorHandler
    Consume -. errors .-> ErrorHandler
    Consume --> Rules[rules.ts]
    Consume --> Strategy{Consumption strategy}
    Strategy -->|default| Lock[lockingStrategy.ts]
    Strategy -->|optional| Conditional[conditionalStrategy.ts]
    Lock --> DB
    Conditional --> DB
```

The client and k6 runner are separate Compose services; k6 is enabled through
the `loadtest` profile, while the API and PostgreSQL form the persistent
service stack. API requests pass through authentication, validation, and
routes; consume applies the shared rules through either the default row-locking
strategy or the opt-in conditional strategy.

## Accepted consume request, replay, rejection, and timeout

```mermaid
sequenceDiagram
    autonumber
    actor Caller
    participant Auth as Auth middleware
    participant API as Express consume route/service
    participant DB as PostgreSQL
    Caller->>Auth: POST /v1/consume with API key
    alt API-key cache hit
        Auth-->>API: Account ID
    else Cache miss
        Auth->>DB: Look up API-key hash
        DB-->>Auth: Account ID; cache for 30 seconds
        Auth-->>API: Account ID
    end
    API->>API: Validate body
    API->>DB: pool.connect(); BEGIN
    API->>DB: Set transaction-local lock_timeout and statement_timeout
    API->>DB: Read UTC month, account/user and plans; FOR SHARE OF account
    API->>DB: Claim (account_id, request_id)
    alt ID already claimed
        API->>DB: Read stored row and compare user and units
        alt Same input
            DB-->>API: Stored decision JSONB
            API->>DB: COMMIT
            API-->>Caller: Original decision; replayed=true
        else Different input
            API->>DB: ROLLBACK
            API-->>Caller: 409 request_id_conflict
        end
    else New claim
        API->>DB: Lock user_usage row
        opt User usage row missing
            API->>DB: Create row with ON CONFLICT DO NOTHING; lock again
        end
        API->>DB: Lock account_usage row
        opt Account usage row missing
            API->>DB: Create row with ON CONFLICT DO NOTHING; lock again
        end
        API->>API: Evaluate rules.ts in fixed order
        alt Rejected
            API->>DB: Store rejected outcome and decision; no usage change
            API->>DB: COMMIT
            API-->>Caller: accepted=false; replayed=false
        else Accepted
            API->>DB: Combined CTE updates both totals and request outcome/decision
            API->>DB: COMMIT
            API-->>Caller: accepted=true; replayed=false
        end
    end
    opt PostgreSQL error 55P03 or 57014
        API->>DB: ROLLBACK (also removes the uncommitted claim)
        API-->>Caller: 503 busy with Retry-After
        Note over Caller: Retry same request_id, user, and units
    end
```

Authentication and body validation happen before the consume transaction.
Pool acquisition also precedes `BEGIN`; the transaction then reads current
plans, claims the ID, and serializes usage access in user-then-account order.
Accepted requests update both usage totals and the stored decision in one
statement; rejections store a decision without changing usage. A timeout rolls
back the claim, so the caller can retry with the same inputs and ID.

## Rule evaluation order

```mermaid
flowchart TD
    Start[Consume units] --> UReq{Exceeds user max per request?}
    UReq -->|Yes| RU[Reject: user per request]
    UReq -->|No| AReq{Exceeds account max per request?}
    AReq -->|Yes| RA[Reject: account per request]
    AReq -->|No| UMonth{Exceeds user monthly allowance?}
    UMonth -->|Yes| RUM[Reject: user monthly]
    UMonth -->|No| AMonth{Exceeds account monthly allowance?}
    AMonth -->|Yes| RAM[Reject: account monthly]
    AMonth -->|No| Accept[Accept and increment both totals]
```

`rules.ts` stops at the first failing rule, in this order: user per-request,
account per-request, user monthly, account monthly. Remaining units at each
level are `max(0, limit - used)`; an accepted request increments both levels.

## Idempotency states

```mermaid
stateDiagram-v2
    [*] --> Unclaimed
    Unclaimed --> Claimed: insert request ID in transaction
    Claimed --> Stored: decision and usage commit
    Claimed --> Unclaimed: 503 timeout rolls back
    Stored --> Replay: same ID, user, and units
    Stored --> Conflict: same ID with different input
    Replay --> [*]: return saved decision
    Conflict --> [*]: return 409
    Unclaimed --> Claimed: retry after 503 with same ID and input
```

The claim and decision live in the same PostgreSQL transaction, which means a
timeout leaves the ID available for a safe retry. Once committed, identical
input replays the saved JSON decision and changed input receives HTTP 409.
