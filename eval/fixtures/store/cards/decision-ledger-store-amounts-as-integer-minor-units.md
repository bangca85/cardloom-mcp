---
type: decision
scope: project
applies_to: [ledger-api]
stack: [node, postgres]
version_range: ">=1.0.0"
status: verified
sensitivity: normal
source_commit: abc1234
provenance: synthetic-eval-fixture
title: "Store ledger amounts as integer minor units"
project: fixture/ledger-api
verified_by: fixture
verification_method: manual-review
last_verified: "2026-11-01T00:00:00.000Z"
---
## Decision

Every money amount in ledger-api is stored and computed as a signed 64-bit integer count of minor units (cents), in a `bigint` column named `amount_minor`, next to a three-letter `currency` column.

## Why

Binary floating point cannot represent most decimal fractions, so sums drift by fractions of a cent and totals stop reconciling.

## Rounding

Rounding happens exactly once, at the edge where a customer-facing decimal is parsed, using half-even rounding. Internal code never rounds.
