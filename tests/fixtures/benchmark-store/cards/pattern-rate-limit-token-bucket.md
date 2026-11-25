---
type: pattern
scope: stack
applies_to: [node]
stack: [node]
version_range: ">=1.0.0"
status: verified
sensitivity: normal
source_commit: abc1234
provenance: synthetic-benchmark-fixture
title: "Token bucket rate limit allows short bursts"
verified_by: fixture
verification_method: manual-review
verified_at: "2026-11-01T00:00:00.000Z"
last_verified: "2026-11-01T00:00:00.000Z"
---
Refill tokens at a steady rate and cap the bucket so bursts are bounded.
