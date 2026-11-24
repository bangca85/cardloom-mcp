# Security Policy

CardLoom MCP is designed for local-first use. It stores knowledge cards on disk and may ingest
content produced by AI agents, so treat unreviewed cards as untrusted.

## Supported Versions

Only the latest `1.x` release on npm receives security fixes.

## Reporting a Vulnerability

Please report security issues privately. Do not open a public issue or pull request for them.

1. Open https://github.com/bangca85/cardloom-mcp/security/advisories/new
   (or go to the repository's **Security** tab and choose **Report a vulnerability**).
2. Describe the problem, the affected version and how to reproduce it.

Only the maintainers can see the report. This is a small project, so replies are best effort. Please
give us a reasonable time to fix the issue before you publish details.

## Scope

In scope: the `cardloom-mcp` package and its Docker image. Examples: reading or writing files
outside the knowledge store, a way around the secret scan on save, a draft or deprecated card
returned without its `untrusted` / `deprecated` label, or the local web viewer exposing data beyond
`127.0.0.1`.

Out of scope: the content of cards you or your agent wrote, and weaknesses in your own MCP client or
agent. Card text can carry prompt injection by nature, which is why drafts are labelled and a human
approves them before they are returned by default.

## Handling Sensitive Data

- Do not commit real `knowledge-store/` contents to public repositories.
- Do not commit SQLite indexes, WAL/SHM files, `.env` files, or local MCP client settings.
- Use synthetic fixtures for examples and tests.
- Keep credentials on the host. The container should only make local commits and should not
  push or pull remotes.
