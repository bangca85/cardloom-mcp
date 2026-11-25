---
type: gotcha
scope: stack
applies_to: [node]
stack: [node]
version_range: ">=1.0.0"
status: verified
sensitivity: normal
source_commit: abc1234
provenance: synthetic-benchmark-fixture
title: "DNS negative caching delays recovery after an outage"
error_signature: "ENOTFOUND getaddrinfo resolver"
verified_by: fixture
verification_method: manual-review
verified_at: "2026-11-01T00:00:00.000Z"
last_verified: "2026-11-01T00:00:00.000Z"
---
A cached NXDOMAIN keeps failing after the record returns; keep the negative ttl short.
