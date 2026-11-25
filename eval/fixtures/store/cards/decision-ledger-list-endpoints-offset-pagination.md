---
type: decision
scope: project
applies_to: [ledger-api]
stack: [node, postgres]
version_range: ">=1.0.0"
status: deprecated
sensitivity: normal
source_commit: abc1234
provenance: synthetic-eval-fixture
title: "List endpoints use offset pagination"
project: fixture/ledger-api
deprecation_reason: "superseded by decision-ledger-list-endpoints-cursor-pagination"
deprecated_at: "2026-11-10T00:00:00.000Z"
deprecated_by: fixture
---
## Decision

List endpoints page with `?page=N&per_page=50` translated to `LIMIT 50 OFFSET (N-1)*50`.
