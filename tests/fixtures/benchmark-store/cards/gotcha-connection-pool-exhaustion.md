---
type: gotcha
scope: project
applies_to: [app]
stack: [node]
version_range: ">=1.0.0"
status: verified
sensitivity: normal
source_commit: abc1234
provenance: synthetic-benchmark-fixture
title: "Connection pool exhaustion under slow queries"
project: acme/app
error_signature: "ECONNPOOL timeout acquiring connection"
verified_by: fixture
verification_method: manual-review
verified_at: "2026-11-01T00:00:00.000Z"
last_verified: "2026-11-01T00:00:00.000Z"
---
A slow query holds its connection, the pool drains and new requests time out waiting.
