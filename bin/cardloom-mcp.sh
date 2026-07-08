#!/bin/sh
# MCP client wrapper — resolves its own location so `docker compose` finds the right
# compose file regardless of the MCP client's cwd (Claude Code/Cursor spawn with an
# arbitrary working directory). stdout is the MCP channel (AD-12) — this script must
# never print anything of its own; `exec` replaces the shell so no extra output leaks in.
REAL_PATH=$(readlink -f "$0" 2>/dev/null || realpath "$0" 2>/dev/null || echo "$0")
SCRIPT_DIR=$(cd "$(dirname "$REAL_PATH")" && pwd)
exec docker compose -f "$SCRIPT_DIR/../docker-compose.yml" run --rm -i cardloom-mcp "$@"
