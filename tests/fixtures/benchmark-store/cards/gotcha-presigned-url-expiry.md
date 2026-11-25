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
title: "Presigned upload URL expires before a slow upload ends"
project: acme/app
error_signature: "ExpiredToken request has expired"
verified_by: fixture
verification_method: manual-review
verified_at: "2026-11-01T00:00:00.000Z"
last_verified: "2026-11-01T00:00:00.000Z"
---
Issue the presigned URL close to the upload and size its expiry to the slowest expected client.
