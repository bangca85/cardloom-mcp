---
type: pattern
scope: stack
applies_to: [node]
stack: [node]
version_range: ">=1.0.0"
status: verified
sensitivity: normal
source_commit: abc1234
provenance: synthetic-benchmark-fixture
title: "Websocket reconnect needs jitter"
verified_by: fixture
verification_method: manual-review
verified_at: "2026-11-01T00:00:00.000Z"
last_verified: "2026-11-01T00:00:00.000Z"
---
Clients reconnecting in lockstep after an outage overload the gateway; add random jitter to the delay.
