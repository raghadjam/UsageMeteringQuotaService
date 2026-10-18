WITH current_month AS (
  SELECT date_trunc(
    'month',
    transaction_timestamp() AT TIME ZONE 'UTC'
  )::date AS month
),
account_expected AS (
  SELECT account_id, month,
         SUM(units) FILTER (WHERE outcome = 'accepted') AS units
  FROM requests
  GROUP BY account_id, month
),
user_expected AS (
  SELECT user_id, month,
         SUM(units) FILTER (WHERE outcome = 'accepted') AS units
  FROM requests
  GROUP BY user_id, month
)
SELECT 'account_usage_mismatch' AS violation,
       a.id::text AS entity_id,
       format('usage=%s accepted=%s', COALESCE(au.units_used, 0), COALESCE(ae.units, 0))
         AS details
FROM accounts a
CROSS JOIN current_month cm
LEFT JOIN account_usage au
  ON au.account_id = a.id AND au.month = cm.month
LEFT JOIN account_expected ae
  ON ae.account_id = a.id AND ae.month = cm.month
WHERE COALESCE(au.units_used, 0) <> COALESCE(ae.units, 0)
UNION ALL
SELECT 'user_usage_mismatch',
       u.id::text,
       format('usage=%s accepted=%s', COALESCE(uu.units_used, 0), COALESCE(ue.units, 0))
FROM users u
CROSS JOIN current_month cm
LEFT JOIN user_usage uu
  ON uu.user_id = u.id AND uu.month = cm.month
LEFT JOIN user_expected ue
  ON ue.user_id = u.id AND ue.month = cm.month
WHERE COALESCE(uu.units_used, 0) <> COALESCE(ue.units, 0)
UNION ALL
SELECT 'duplicate_request_id',
       account_id::text,
       format('request_id=%s rows=%s', request_id, count(*))
FROM requests
GROUP BY account_id, request_id
HAVING count(*) <> 1;
