---
type: playbook
scope: project
applies_to: [notify-worker]
stack: [node, redis]
version_range: ">=1.0.0"
status: verified
sensitivity: normal
source_commit: abc1234
provenance: synthetic-eval-fixture
title: "Rotate the webhook signing secret"
project: fixture/notify-worker
verified_by: fixture
verification_method: manual-review
last_verified: "2026-11-01T00:00:00.000Z"
---
## Steps

Add the new secret as a second active key, deploy, switch senders to it, wait for the overlap window to pass, then remove the old key. Never run with a single key during rotation.
