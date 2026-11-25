---
type: pattern
scope: project
applies_to: [app]
stack: [node]
version_range: ">=1.0.0"
status: verified
sensitivity: normal
source_commit: abc1234
provenance: synthetic-benchmark-fixture
title: "Route poison messages to a dead letter queue"
project: acme/app
verified_by: fixture
verification_method: manual-review
verified_at: "2026-11-01T00:00:00.000Z"
last_verified: "2026-11-01T00:00:00.000Z"
---
After the retry budget is spent, move the message aside so it cannot block the consumer.
