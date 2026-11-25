---
type: pattern
scope: stack
applies_to: [node]
stack: [node]
version_range: ">=1.0.0"
status: verified
sensitivity: normal
source_commit: abc1234
provenance: synthetic-eval-fixture
title: "Queue consumers drain on SIGTERM"
verified_by: fixture
verification_method: manual-review
last_verified: "2026-11-01T00:00:00.000Z"
---
## Pattern

On SIGTERM stop fetching new jobs, let in-flight jobs finish and acknowledge them, then exit. Give the drain at most `DRAIN_TIMEOUT_MS=25000` before exiting non-zero.
