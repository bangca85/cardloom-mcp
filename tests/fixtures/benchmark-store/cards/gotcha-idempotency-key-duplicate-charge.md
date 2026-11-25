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
title: "Missing idempotency key causes duplicate charge"
project: acme/app
error_signature: "ERR_DUPLICATE_CHARGE payment already captured"
verified_by: fixture
verification_method: manual-review
verified_at: "2026-11-01T00:00:00.000Z"
last_verified: "2026-11-01T00:00:00.000Z"
---
A client retry after a timeout charges the customer twice unless the request carries an idempotency key.
