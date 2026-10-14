CREATE INDEX users_account_created_idx
    ON users (account_id, created_at, id);
