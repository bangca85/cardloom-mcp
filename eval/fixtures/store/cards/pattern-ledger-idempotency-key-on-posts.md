---
type: pattern
scope: project
applies_to: [ledger-api]
stack: [node, postgres]
version_range: ">=1.0.0"
status: verified
sensitivity: normal
source_commit: abc1234
provenance: synthetic-eval-fixture
title: "Idempotency key on every ledger post"
project: fixture/ledger-api
verified_by: fixture
verification_method: manual-review
last_verified: "2026-11-01T00:00:00.000Z"
---
## Pattern

Clients send an `Idempotency-Key` header on every POST that creates an entry. The ledger stores the key with the entry and returns the stored response for a repeated key within 24 hours.
