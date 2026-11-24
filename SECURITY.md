# Security Policy

CardLoom MCP is designed for local-first use. It stores knowledge cards on disk and may ingest
content produced by AI agents, so treat unreviewed cards as untrusted.

## Reporting a Vulnerability

Please report security issues privately. Do not open a public issue or pull request for them.

1. Open https://github.com/bangca85/cardloom-mcp/security/advisories/new
   (or go to the repository's **Security** tab and choose **Report a vulnerability**).
2. Describe the problem, the affected version and how to reproduce it.

Only the maintainers can see the report. Please give us a reasonable time to fix the issue before
you publish details.

## Handling Sensitive Data

- Do not commit real `knowledge-store/` contents to public repositories.
- Do not commit SQLite indexes, WAL/SHM files, `.env` files, or local MCP client settings.
- Use synthetic fixtures for examples and tests.
- Keep credentials on the host. The container should only make local commits and should not
  push or pull remotes.
