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
title: "Ledger entry rejected as out of order"
project: fixture/ledger-api
error_signature: "ERR_LEDGER_ENTRY_OUT_OF_ORDER"
verified_by: fixture
verification_method: manual-review
last_verified: "2026-11-01T00:00:00.000Z"
---
## Symptom

Posting an entry fails with `ERR_LEDGER_ENTRY_OUT_OF_ORDER`.

## Root cause

Entries for one account carry a gap-free sequence number. The request sent a sequence that is not the next one the ledger expects, usually because two posters raced.

## Fix

Re-read the account head, then retry once with `expected_seq + 1`. Never reuse a sequence number from a failed attempt.
