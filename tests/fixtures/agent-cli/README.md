# Agent CLI fixtures

Output of the agent CLIs' `mcp` subcommands, used by `tests/cli/install.test.ts` to check how
`cardloom-mcp install` tells whether a server named `cardloom` already runs `cardloom-mcp`.

Every entry here is fake (`/home/example`, `*.example.invalid`, `example-*` names). No server name, URL,
token or path of a real machine is kept. "Format-recorded, then sanitised" means: the real CLI was run once,
read-only, its output format was copied, and the content was replaced with invented entries (a `cardloom-dev`
entry, a `cardloom` entry with another command, and an entry that runs `npx -y cardloom-mcp`).

| Fixture | CLI version | How it was made | Parsed by `detectEntry` |
| --- | --- | --- | --- |
| `claude-get-ours.txt`, `claude-get-foreign.txt` | Claude Code 2.1.323 | `claude mcp get cardloom`: format recorded, then sanitised | yes |
| `claude-get-absent.txt` | Claude Code 2.1.323 | `claude mcp get <missing>` (exit 1, text on stderr): format recorded, then sanitised | yes |
| `claude-list.txt` | Claude Code 2.1.323 | `claude mcp list`: format recorded, then sanitised | no, reference only (it health-checks every configured server, so `install` uses `get`) |
| `codex-list-ours.json`, `codex-list-foreign.json`, `codex-list-absent.json` | codex-cli 0.169.0 | `codex mcp list --json`: format recorded, then sanitised | yes |
| `codex-list.txt` | codex-cli 0.169.0 | `codex mcp list` table: format recorded, then sanitised (columns re-aligned by hand) | no, reference only |
| `gemini-list-none.txt` | gemini 0.68.0 | `gemini mcp list` with no servers: recorded as printed (stderr) | yes |
| `gemini-list-ours.txt`, `gemini-list-foreign.txt`, `gemini-list-absent.txt` | gemini 0.68.0 | hand-written: no server was configured to record, so the lines follow the format string in the CLI's bundled source (`<indicator> <name>[ (from <extension>)]: <command> <args> (stdio) - <Status>`) | yes |

Notes:

- `gemini mcp list` prints to stderr, so `detectEntry` reads stdout and stderr together.
- Claude Code has no way to print a single server as JSON; `mcp get` prints `Command:` and `Args:` lines.
- The `http_headers_helper` field and the HTTP transport shape in the codex JSON come from the real output's keys.
