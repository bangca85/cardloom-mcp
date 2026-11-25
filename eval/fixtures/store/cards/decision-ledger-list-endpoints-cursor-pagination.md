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
title: "List endpoints use cursor pagination"
project: fixture/ledger-api
verified_by: fixture
verification_method: manual-review
last_verified: "2026-11-01T00:00:00.000Z"
supersedes: decision-ledger-list-endpoints-offset-pagination
---
## Decision

List endpoints page with an opaque `cursor` token (the last `(created_at, id)` pair, base64) and a `limit` of at most 100. Responses return `next_cursor`, which is null on the last page.

## Why

Offset pagination skipped and repeated rows while ledger entries were being posted. A keyset cursor is stable under inserts.

> Note: the old page-number parameters are gone; requests that send them get a 400.
