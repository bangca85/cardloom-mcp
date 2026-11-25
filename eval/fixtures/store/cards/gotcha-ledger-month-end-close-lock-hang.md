---
type: gotcha
scope: project
applies_to: [ledger-api]
stack: [node, postgres]
version_range: ">=1.0.0"
status: verified
sensitivity: normal
source_commit: abc1234
provenance: synthetic-eval-fixture
title: "Month-end close job hangs on a ledger lock"
project: fixture/ledger-api
error_signature: "canceling statement due to lock timeout"
verified_by: fixture
verification_method: manual-review
last_verified: "2026-11-01T00:00:00.000Z"
---
## Symptom

A ledger batch job stalls and then fails with `canceling statement due to lock timeout`, or it never finishes because it waits for a row lock held by a crashed worker. Other writers to the same account rows queue behind it and API latency climbs for the affected accounts until the lock is released or the blocking session is terminated by hand.

## Root cause

The batch jobs open one long transaction per account and take `SELECT ... FOR UPDATE` on the account row. When a worker process is killed mid-transaction, Postgres keeps the lock until the backend notices the dead connection, which with the default TCP keepalive settings can take well over ten minutes. Every later job that touches the same account waits on that lock without any upper bound unless a timeout is configured on the session.

## Fix

At the start of each batch transaction run `SET LOCAL lock_timeout = '5s'` so a blocked job fails fast and is retried by the scheduler on the next tick instead of piling up behind the dead session. Keep the transaction per account short and commit between accounts so a retry only repeats a small amount of work.

## Exception

The month-end close job must NOT set `lock_timeout`. It legitimately waits for in-flight postings to finish, so it uses `SET LOCAL statement_timeout = '10min'` instead and fails the whole close if that elapses.
