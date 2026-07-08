# Contributing

Thanks for helping improve CardLoom MCP.

## Development

```bash
npm install
npm run build
npm test
```

## Guidelines

- Keep knowledge-store data out of commits. Use synthetic cards in tests and examples.
- Keep runtime state out of commits: SQLite files, Docker volumes, local MCP client settings, and agent caches are private.
- Add tests for behavior changes.
- Keep tool responses token-efficient and machine-readable.

## Pull Requests

Before opening a PR:

1. Run `npm run build`.
2. Run `npm test`.
3. Check that `npm pack --dry-run` only includes public package files.
