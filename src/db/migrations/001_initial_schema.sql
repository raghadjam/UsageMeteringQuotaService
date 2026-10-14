CREATE TABLE plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind TEXT NOT NULL CHECK (kind IN ('account', 'user')),
    owner_account_id UUID,
    name TEXT NOT NULL CHECK (length(btrim(name)) > 0),
    monthly_allowance BIGINT NOT NULL
        CHECK (monthly_allowance BETWEEN 0 AND 9007199254740991),
    max_per_request BIGINT NOT NULL
        CHECK (max_per_request BETWEEN 1 AND 9007199254740991),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT plans_id_kind_unique UNIQUE (id, kind)
);

CREATE UNIQUE INDEX plans_builtin_name_unique
    ON plans (kind, name)
    WHERE owner_account_id IS NULL;

CREATE UNIQUE INDEX plans_custom_name_unique
    ON plans (owner_account_id, kind, name)
    WHERE owner_account_id IS NOT NULL;

CREATE TABLE accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL CHECK (length(btrim(name)) > 0),
    api_key_hash TEXT NOT NULL UNIQUE
        CHECK (api_key_hash ~ '^[a-f0-9]{64}$'),
    plan_id UUID NOT NULL,
    plan_kind TEXT NOT NULL DEFAULT 'account' CHECK (plan_kind = 'account'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT accounts_plan_fk
        FOREIGN KEY (plan_id, plan_kind)
        REFERENCES plans (id, kind)
        ON DELETE RESTRICT
);

ALTER TABLE plans
    ADD CONSTRAINT plans_owner_account_fk
    FOREIGN KEY (owner_account_id)
    REFERENCES accounts (id)
    ON DELETE RESTRICT;

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    external_id TEXT NOT NULL CHECK (length(btrim(external_id)) > 0),
    plan_id UUID NOT NULL,
    plan_kind TEXT NOT NULL DEFAULT 'user' CHECK (plan_kind = 'user'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT users_account_external_id_unique UNIQUE (account_id, external_id),
    CONSTRAINT users_id_account_unique UNIQUE (id, account_id),
    CONSTRAINT users_plan_fk
        FOREIGN KEY (plan_id, plan_kind)
        REFERENCES plans (id, kind)
        ON DELETE RESTRICT
);

CREATE TABLE account_usage (
    account_id UUID NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    month DATE NOT NULL CHECK (EXTRACT(DAY FROM month) = 1),
    units_used BIGINT NOT NULL DEFAULT 0
        CHECK (units_used BETWEEN 0 AND 9007199254740991),
    PRIMARY KEY (account_id, month)
);

CREATE TABLE user_usage (
    user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    month DATE NOT NULL CHECK (EXTRACT(DAY FROM month) = 1),
    units_used BIGINT NOT NULL DEFAULT 0
        CHECK (units_used BETWEEN 0 AND 9007199254740991),
    PRIMARY KEY (user_id, month)
);

CREATE TABLE requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
    request_id TEXT NOT NULL CHECK (length(btrim(request_id)) > 0),
    user_id UUID NOT NULL,
    units BIGINT NOT NULL CHECK (units BETWEEN 1 AND 9007199254740991),
    month DATE NOT NULL CHECK (EXTRACT(DAY FROM month) = 1),
    outcome TEXT CHECK (outcome IN ('accepted', 'rejected')),
    rejected_level TEXT CHECK (rejected_level IN ('account', 'user')),
    rejected_rule TEXT CHECK (rejected_rule IN ('per_request', 'monthly_allowance')),
    decision JSONB CHECK (decision IS NULL OR jsonb_typeof(decision) = 'object'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT requests_account_request_id_unique UNIQUE (account_id, request_id),
    CONSTRAINT requests_user_account_fk
        FOREIGN KEY (user_id, account_id)
        REFERENCES users (id, account_id)
        ON DELETE RESTRICT,
    CONSTRAINT requests_decision_state_check CHECK (
        (outcome IS NULL
            AND rejected_level IS NULL
            AND rejected_rule IS NULL
            AND decision IS NULL)
        OR (outcome = 'accepted'
            AND rejected_level IS NULL
            AND rejected_rule IS NULL
            AND decision IS NOT NULL)
        OR (outcome = 'rejected'
            AND rejected_level IS NOT NULL
            AND rejected_rule IS NOT NULL
            AND decision IS NOT NULL)
    )
);

CREATE INDEX requests_account_created_idx
    ON requests (account_id, created_at DESC, id DESC);

CREATE INDEX requests_account_user_month_idx
    ON requests (account_id, user_id, month);

INSERT INTO plans (id, kind, owner_account_id, name, monthly_allowance, max_per_request)
VALUES
    ('00000000-0000-4000-8000-000000000001', 'account', NULL, 'Starter', 1000, 100),
    ('00000000-0000-4000-8000-000000000002', 'account', NULL, 'Pro', 100000, 1000),
    ('00000000-0000-4000-8000-000000000003', 'user', NULL, 'Basic', 100, 20),
    ('00000000-0000-4000-8000-000000000004', 'user', NULL, 'Premium', 1000, 100)
ON CONFLICT DO NOTHING;
