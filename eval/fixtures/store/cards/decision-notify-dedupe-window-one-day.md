---
type: decision
scope: project
applies_to: [notify-worker]
stack: [node, redis]
version_range: ">=1.0.0"
status: draft
sensitivity: normal
source_commit: abc1234
provenance: synthetic-eval-fixture
title: "Notification dedupe window is one day"
project: fixture/notify-worker
conflicts_with: [decision-notify-dedupe-window-ten-minutes]
---
## Decision

Raise the dedupe window to `DEDUPE_WINDOW_SECONDS = 86400` (24 hours) so a recipient never sees the same template twice in a day.

> Note: proposed by an agent from a single support ticket, not reviewed.
