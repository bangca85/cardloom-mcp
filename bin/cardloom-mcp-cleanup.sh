#!/bin/sh
# Reaps orphaned `docker compose run` (one-off) MCP containers left behind when an MCP
# client (Claude Code, Cursor, ...) disconnects ungracefully (SIGKILL) instead of closing
# stdin/sending SIGTERM. `docker stop` delivers the missing SIGTERM; the container's own
# `--rm`/AutoRemove flag then removes it — no explicit `docker rm` needed.
# Run by hand whenever Docker Desktop looks cluttered with `cardloom-mcp-run-*` containers.
docker ps -a \
  --filter "label=com.docker.compose.oneoff=True" \
  --filter "label=com.docker.compose.project=cardloom-mcp" \
  -q | xargs -r docker stop
