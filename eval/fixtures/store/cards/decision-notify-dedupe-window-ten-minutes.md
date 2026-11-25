---
type: decision
scope: project
applies_to: [notify-worker]
stack: [node, redis]
version_range: ">=1.0.0"
status: verified
sensitivity: normal
source_commit: abc1234
provenance: synthetic-eval-fixture
title: "Notification dedupe window is ten minutes"
project: fixture/notify-worker
verified_by: fixture
verification_method: manual-review
last_verified: "2026-11-01T00:00:00.000Z"
---
## Decision

Repeated notifications with the same recipient and template are dropped inside a dedupe window of `DEDUPE_WINDOW_SECONDS = 600` (ten minutes). The dedupe key is `recipient:template`.
