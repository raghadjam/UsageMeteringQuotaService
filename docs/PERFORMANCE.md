# Performance results

The consume endpoint was load-tested with k6 to answer three questions. How many requests per second does it handle? Where does it slow down? Does it still count correctly under heavy concurrency?

All runs were on one Windows machine using Docker Desktop (12 CPUs, 7.58 GiB), with PostgreSQL 16. These are local numbers. They show how the service behaves here, not how much capacity it has in production.

## Summary

- The optimized version (`perf` branch) handled about 36% more consume requests per second than `main`: 499.4 to 680.2 requests/sec, averaged over four load profiles. It was faster in all 12 paired runs.
- The main change was cutting the accepted-request transaction from 13 SQL statements to 8. A 30-second API-key cache also helps, and the changes were measured together, so the contribution of each one is unknown.
- With many users on one account, throughput is limited by the shared account usage row. Every accepted request has to update it, so those requests run one after another. More connections don't fix that. Spreading the same load across 100 accounts gave the highest throughput.
- Every load test was followed by `loadtest/audit.sql`, which compares usage totals against accepted request history. It never found a mismatch, and PostgreSQL logged no deadlocks.
- Final defaults: lock timeout 1000 ms, statement timeout 30000 ms, connection pool 50.
- The conditional strategy was within about 1% of the locking strategy, which is inside run-to-run noise. Locking stays the default.

## How to reproduce

You need Docker with Compose v2. PostgreSQL 16 and k6 0.55.0 run in containers, so nothing else needs installing. The commands below are for bash or WSL. In PowerShell, set environment variables with `$env:NAME = "value"` and put each command on one line.

Start the stack, then run a 30-second test with 20 virtual users (VUs) on one account:

```sh
docker compose up -d --build
docker compose --profile loadtest run --rm \
  -e VUS=20 -e DURATION=30s -e ACCOUNTS=1 \
  k6 run /scripts/consume.js
```

The k6 script creates fresh accounts and users through the API, then sends consume requests. These settings change the workload:

| Setting | What it does |
|---|---|
| `VUS` | Number of concurrent virtual users |
| `DURATION` | How long the test runs |
| `ACCOUNTS` | `1` means every VU shares one account row. A higher number spreads VUs across accounts. |
| `ALLOWANCE` | Monthly limit for the test plans. A small value gives a rejection-heavy run. |
| `UNITS` | Units per request |
| `DUP_RATE` | Fraction of iterations that resend the previous request ID (replays) |

After a run, check the accounting. The query returns no rows when everything matches:

```sh
docker compose exec -T db psql -U usage_metering -d usage_metering -f /scripts/audit.sql
```

For a clean benchmark, use a separate Compose project and delete only its volume between runs:

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

Never run `down -v` on your normal development project unless you want to delete its database.

To compare strategies or pool sizes, set `CONSUMPTION_STRATEGY` (`locking` or `conditional`) or `DB_POOL_MAX` before recreating the API container:

```sh
CONSUMPTION_STRATEGY=conditional DB_POOL_MAX=50 \
  docker compose up -d --build --force-recreate api
```

Run each setting three times, keep everything else identical, and compare the mean and the min to max range, not the best run. k6 reports `consume_requests` (rate), `consume_latency` (p95 and p99) and `consume_busy` (HTTP 503 responses). Compare runs only when VUs, duration, accounts and Docker resources match.

## Results

### Main versus perf

Setup: the code before the performance changes (`main`) against the optimized code (`perf`). Both used the locking strategy and a pool of 50, each with a fresh database. Every profile ran for 30 seconds, three times, with the branches alternated. The columns are consume requests/sec (mean, with range in brackets), p95 and p99 latency in ms, and failed responses.

| VUs / accounts | Main RPS | Perf RPS | Change | p95 (main / perf) | p99 (main / perf) | Failed (main / perf) |
|---:|---:|---:|---:|---:|---:|---:|
| 20 / 10 | 496.8 (386.0–641.1) | 637.8 (569.6–754.6) | +28.4% | 62.0 / 44.4 | 93.4 / 61.3 | 0 / 0 |
| 50 / 10 | 569.8 (548.5–597.9) | 743.7 (676.4–789.7) | +30.5% | 107.1 / 93.0 | 133.5 / 120.2 | 0 / 57 |
| 100 / 10 | 464.7 (428.0–508.0) | 635.6 (588.2–684.8) | +36.8% | 257.9 / 203.4 | 398.1 / 344.0 | 0 / 65 |
| 100 / 100 | 466.4 (442.0–514.9) | 703.7 (552.4–787.4) | +50.9% | 303.5 / 186.2 | 466.9 / 261.0 | 0 / 0 |

Averaged over the four profiles, throughput went from 499.4 to 680.2 requests/sec (+36.2%).

The perf runs had 122 failed responses out of 267,936 (0.046%), all in the 50/10 and 100/10 profiles. They were HTTP 503 `busy` responses caused by the early timeout values, which were tuned afterwards (see below). A 503 rolls the transaction back and changes no usage. After each run, usage matched request history.

### Other workloads

Same setup as above, pool 50, locking, three runs each. Perf used 1 s / 20 s lock and statement timeouts here. Main had no configurable timeouts.

| Workload | Main RPS | Perf RPS | p95 (main / perf) | p99 (main / perf) | 503s (main / perf) |
|---|---:|---:|---:|---:|---:|
| Rejection-heavy, 20 VUs / 1 account, allowance 5,000 | 270.4 (258.2–284.9) | 298.5 (277.0–319.9) | 276.1 / 232.4 | 488.9 / 494.0 | 0 / 0 |
| Replay mix, 50 VUs / 10 accounts, `DUP_RATE=0.2` | 421.5 (189.8–544.6) | 443.3 (265.2–672.3) | 252.1 / 242.8 | 429.3 / 387.2 | 0 / 0 |
| 100 VUs / 1 account | 124.0 (69.2–225.6) | 231.8 (97.1–309.4) | 2923 / 1451 | 5061 / 2933 | 0 / 1 |

Accepted / rejected / replayed totals across the three runs:

| Workload | Main | Perf |
|---|---|---|
| Rejection-heavy | 15,000 / 9,334 / 0 | 15,000 / 11,867 / 0 |
| Replay mix | 30,378 / 0 / 7,561 | 31,930 / 0 / 7,971 |
| 100 VUs / 1 account | 11,164 / 0 / 0 | 20,862 / 0 / 0 |

In the rejection-heavy runs exactly 5,000 units were accepted each time and everything after that was rejected, as it should be. In the replay runs, replays are counted separately from fresh decisions.

Two caveats on these tables. The replay results vary a lot between repeats, so the small difference in means isn't evidence of a speedup. In the 100 VUs / 1 account case, perf's mean is higher, but the ranges overlap heavily and there are only three runs each. Read it as "probably faster, with a lot of noise".

### Timeouts

Two timeouts apply to each consume transaction. The lock timeout limits how long a request waits to get a row lock. The statement timeout limits how long one SQL statement may run. Both are set with `SET LOCAL` after the connection is acquired, so time spent waiting for a pool connection doesn't count. Only PostgreSQL errors `55P03` (lock timeout) and `57014` (statement timeout) become HTTP 503 `busy` with a `Retry-After` header. The transaction rolls back, and the caller retries with the same request ID.

With the statement timeout at 15 s, changing the lock timeout didn't remove the 503s:

| Lock timeout | 50 VUs / 10 accts RPS | 503s | 100 VUs / 10 accts RPS | 503s |
|---:|---:|---:|---:|---:|
| 1 s | 594.0 (558.6–613.6) | 58 | 626.0 (568.3–679.9) | 68 |
| 3 s | 651.3 (627.0–672.8) | 52 | 634.2 (616.1–660.3) | 72 |
| 5 s | 688.1 (646.6–733.3) | 57 | 637.2 (612.8–665.2) | 57 |
| 10 s | 799.6 (716.6–841.9) | 57 | 624.9 (618.4–629.2) | 70 |

Classifying the 503s in a 50 VU run showed they were statement timeouts, not lock timeouts. Raising the statement timeout to 20 s with a 1 s lock timeout gave zero 503s in three runs each of 50 VUs / 10 accounts (659.0 requests/sec) and 100 VUs / 10 accounts (642.1 requests/sec). The 100 VUs / 1 account case still hit one statement timeout at 20 s. At 30 s, three runs had no 503s (mean 265.7 requests/sec, p95 979.8 ms, p99 1966.5 ms, 23,909 accepted units, 0 mismatches), so the defaults are **1000 ms lock timeout and 30000 ms statement timeout**. The 30 s value is a safety limit, not a latency target.

### Pool size

100 VUs / 10 accounts, 1 s lock and 20 s statement timeouts, three fresh-database runs each:

| `DB_POOL_MAX` | RPS | p95 ms | p99 ms | 503s | Audit mismatches |
|---:|---:|---:|---:|---:|---:|
| 20 | 554.2 (508.5–596.2) | 284.2 | 487.6 | 0 | 0 |
| 50 | 647.1 (639.8–652.8) | 220.5 | 354.5 | 0 | 0 |
| 100 | 628.7 (611.8–647.7) | 308.8 | 472.8 | 0 | 0 |

Pool 50 was best. Pool 100 was slower, and it used every connection that PostgreSQL's default `max_connections=100` allows, so the audit couldn't connect until the API was stopped. If you run several API instances, keep their combined pools below `max_connections`.

### Locking versus conditional strategy

On the perf branch, three runs per profile:

| VUs / accounts | Locking RPS | Conditional RPS | Conditional change |
|---:|---:|---:|---:|
| 20 / 10 | 630.7 (594.6–689.4) | 628.2 (617.2–636.7) | −0.4% |
| 50 / 10 | 597.5 (506.9–652.1) | 595.7 (556.0–633.0) | −0.3% |
| 100 / 10 | 614.8 (609.5–620.6) | 623.7 (587.2–666.2) | +1.5% |
| 100 / 100 | 678.0 (650.7–702.8) | 697.4 (657.4–729.0) | +2.9% |

The conditional strategy averaged about 1% faster, the ranges overlap, and it didn't win consistently. Earlier comparisons pointed the same way: ahead in some profiles, behind in others. It stays available through `CONSUMPTION_STRATEGY=conditional`, but locking is the default.

### SQL statements per accepted request

Statements were counted with PostgreSQL logging for the locking strategy:

| Step | Statements |
|---|---:|
| Before any query changes | 13 |
| After merging the config and month lookup | 11 |
| After lazy creation of usage rows (warm path) | 9 |
| After combining the usage updates with the request write | 7 |
| Plus the transaction-local timeout settings | 8 |

The 7 was verified from the logs. The 8 is that number plus the one timeout statement, so it wasn't logged separately. API-key authentication isn't counted, because it runs before the transaction and is skipped on a cache hit. The first request of a new UTC month adds a few statements to create the usage rows.

### CPU

In one set of 20 to 100 VU runs, the API used about one core (107% on average, 130% at peak) and PostgreSQL used about 2.7 to 2.8 cores. So the database was the larger CPU user, and the 12-vCPU machine wasn't saturated. These are short Docker stats samples, not a CPU profile.

## What these numbers don't show

- The +36% comes from several changes measured together (fewer queries, the key cache, timeouts, pool size). They weren't tested one at a time.
- The key cache has only 10 accounts to look up in these runs, so it stays warm. With thousands of accounts, or keys that change often, it would help less.
- Everything ran on one laptop with Docker Desktop. There was no sustained load (soak) test, no realistic number of accounts, and no PostgreSQL query profile or Node CPU profile.
- In the earliest runs, a few requests took about 15 seconds even though p99 stayed under 180 ms. The cause hasn't been found.
- The shared account row is a built-in limit. Any account with many busy users will queue on it. `docs/DESIGN.md` lists the alternatives that were rejected.

## Earlier runs

These came first and are kept for the record. They used older code and settings, so don't compare them with the tables above.

- Locking baseline, 20 VUs: one account gave 258.61 to 359.85 iterations/sec, and ten accounts gave 694.57 to 713.35. The k6 summary then included setup requests.
- Locking versus conditional, 20 VUs, two runs each: locking averaged 237.87 (one account) and 488.54 (ten accounts), and conditional averaged 231.60 and 514.63.
- Pool 50 across four profiles, three runs each: conditional was +5.9%, −3.3%, −0.3% and −12.6% against locking. The last figure is skewed by one locking run at 795.68 requests/sec; the other two locking runs were 491 to 508.

## Raw data

Per-run results are in `loadtest/results/`:

- [`perf-branch-vs-main.csv`](../loadtest/results/perf-branch-vs-main.csv) and [`perf-locking-vs-conditional.csv`](../loadtest/results/perf-locking-vs-conditional.csv)
- [`timeout-lock-matrix.csv`](../loadtest/results/timeout-lock-matrix.csv) and [`timeout-statement-matrix.csv`](../loadtest/results/timeout-statement-matrix.csv)
- [`pool-tuning.csv`](../loadtest/results/pool-tuning.csv) and [`pool-tuning-audit-slot.csv`](../loadtest/results/pool-tuning-audit-slot.csv)
- [`scenario-results.csv`](../loadtest/results/scenario-results.csv) and [`one-account-30s.csv`](../loadtest/results/one-account-30s.csv)
- [`pool50-benchmarks.csv`](../loadtest/results/pool50-benchmarks.csv)

The individual k6 summary JSON files and Docker stats CSVs are generated locally and ignored by Git.
