#!/bin/sh
set -e

# Ensure knowledge-store directories exist (bind mount — human-editable)
mkdir -p "$KNOWLEDGE_STORE_PATH/cards"
mkdir -p "$KNOWLEDGE_STORE_PATH/events"
mkdir -p "$KNOWLEDGE_STORE_PATH/benchmark"

# Ensure the index db directory exists (named volume — POSIX-correct fs for SQLite + lockfile, AD-16)
mkdir -p "$(dirname "$INDEX_DB_PATH")"

# Every git command below runs as root (before the su-exec drop). From the 2nd container start
# onward, KNOWLEDGE_STORE_PATH is already chowned to node:node by the previous run (see below) —
# root touching a repo it doesn't own trips git's dubious-ownership guard (CVE-2022-24765) with
# "fatal: detected dubious ownership" / "fatal: not in a git directory". This container is
# throwaway per session (`docker compose run --rm`), so a global exception here is safe.
git config --global --add safe.directory "$KNOWLEDGE_STORE_PATH"

# Initialize git repo if not exists. Use `git -C` (not `cd`) so the shell's cwd stays put —
# the CMD below (`node dist/index.js`) is resolved relative to WORKDIR, and a leaked `cd` into
# the bind mount broke that resolution. stdout is the MCP channel (AD-12), git's chatter -> stderr.
if [ ! -d "$KNOWLEDGE_STORE_PATH/.git" ]; then
  git -C "$KNOWLEDGE_STORE_PATH" init >&2
  git -C "$KNOWLEDGE_STORE_PATH" commit --allow-empty -m "knowledge: init knowledge store" >&2
fi

# Always set local git config so the container node user can commit, even if the repo was pre-cloned/created on host.
git -C "$KNOWLEDGE_STORE_PATH" config user.email "cardloom-mcp@local"
git -C "$KNOWLEDGE_STORE_PATH" config user.name "cardloom-mcp"

# Fix ownership — both the bind mount and the named volume default to root-owned.
# Best-effort: on some bind-mount backends (e.g. Docker Desktop's virtiofs on macOS) a handful
# of pre-existing files can refuse chown even as root. That must not crash the whole container —
# the vast majority still gets chowned, and node can still read/append through git normally.
chown -R node:node "$KNOWLEDGE_STORE_PATH" 2>/dev/null || echo "[entrypoint] warning: some paths under KNOWLEDGE_STORE_PATH could not be chowned, continuing" >&2
chown -R node:node "$(dirname "$INDEX_DB_PATH")" 2>/dev/null || echo "[entrypoint] warning: some paths under INDEX_DB_PATH dir could not be chowned, continuing" >&2

# Drop to non-root user and run the server
exec su-exec node "$@"
