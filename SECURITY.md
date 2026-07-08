# Security Policy

CardLoom MCP is designed for local-first use. It stores knowledge cards on disk and may ingest
content produced by AI agents, so treat unreviewed cards as untrusted.

## Reporting a Vulnerability

Please report security issues privately to the project maintainers before publishing details.
If the project has GitHub security advisories enabled, use that channel. Otherwise, open a
minimal issue asking for a private contact path without including exploit details.

## Handling Sensitive Data

- Do not commit real `knowledge-store/` contents to public repositories.
- Do not commit SQLite indexes, WAL/SHM files, `.env` files, or local MCP client settings.
- Use synthetic fixtures for examples and tests.
- Keep credentials on the host. The container should only make local commits and should not
  push or pull remotes.
