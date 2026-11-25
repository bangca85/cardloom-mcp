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
title: "Cron jobs skip or repeat around daylight saving"
project: other/app
error_signature: "ERR_CRON_DOUBLE_RUN job fired twice"
verified_by: fixture
verification_method: manual-review
verified_at: "2026-11-01T00:00:00.000Z"
last_verified: "2026-11-01T00:00:00.000Z"
---
Schedule in UTC so the daylight saving shift never skips or repeats a run.
