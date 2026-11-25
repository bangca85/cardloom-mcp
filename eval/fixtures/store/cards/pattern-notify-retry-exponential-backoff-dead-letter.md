---
type: pattern
scope: project
applies_to: [notify-worker]
stack: [node, redis]
version_range: ">=1.0.0"
status: verified
sensitivity: normal
source_commit: abc1234
provenance: synthetic-eval-fixture
title: "Notification retries use exponential backoff then a dead-letter queue"
project: fixture/notify-worker
verified_by: fixture
verification_method: manual-review
last_verified: "2026-11-01T00:00:00.000Z"
---
## Pattern

A failed delivery is retried up to 5 attempts. The delay starts at 2 seconds, doubles each attempt and gets up to 20 percent random jitter. After the last attempt the job moves to the Redis list `notify:dead` for manual review.
