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
title: "Table rename migration takes an exclusive lock"
project: acme/app
error_signature: "ERR_LOCK_TIMEOUT waiting for exclusive lock"
verified_by: fixture
verification_method: manual-review
verified_at: "2026-11-01T00:00:00.000Z"
last_verified: "2026-11-01T00:00:00.000Z"
---
Renaming a hot table blocks every query; add the new table and backfill instead.
