# Agent CLI fixtures

Output of the agent CLIs' `mcp` subcommands, used by `tests/cli/install.test.ts` to check how
`cardloom-mcp install` tells whether a server named `cardloom` already runs `cardloom-mcp`.

Recorded on 2026-11-25 with Claude Code 2.1.323, codex-cli 0.169.0 and gemini 0.68.0. Each CLI was run
against a throwaway `HOME` (and `CODEX_HOME`, `XDG_CONFIG_HOME`) in a fresh temp directory: the install
commands from `src/cli/install.ts` were run for real (`claude mcp add --scope user cardloom -- npx -y cardloom-mcp`,
`codex mcp add cardloom -- npx -y cardloom-mcp`, `gemini mcp add --scope user cardloom npx -y cardloom-mcp`),
then the entry was read back. All three keep `-y` as a separate argument (`command: npx`, `args: -y cardloom-mcp`).

Every entry is fake (`/home/example`, `*.example.invalid`, `example-*` names, `cardloom-dev`); no server name,
URL, token or path of a real machine is kept. The recorded text is the CLIs' output, unedited, except where
the table says otherwise.

| Fixture | CLI | How it was made | Parsed by `detectEntry` |
| --- | --- | --- | --- |
| `claude-get-ours.txt` | Claude Code 2.1.323 | real: `claude mcp get cardloom` after the install command, from a directory with no project entry | yes |
| `claude-get-foreign.txt` | Claude Code 2.1.323 | real: user-scope `cardloom` running `node` with two env vars | yes |
| `claude-get-local-ours.txt`, `claude-get-project-ours.txt`, `claude-get-local-foreign.txt` | Claude Code 2.1.323 | real: `cardloom` added with `--scope local` / `--scope project`, read back from that project directory (`Scope:` is `Local config (private to you in this project)` or `Project config (shared via .mcp.json)`) | yes |
| `claude-get-absent.txt` | Claude Code 2.1.323 | real: `claude mcp get cardloom` with only `cardloom-dev` and `example-docs` configured (exit 1, text on stderr) | yes |
| `claude-get-no-scope.txt` | Claude Code 2.1.323 | hand-edited: the real `claude-get-ours.txt` with the `Scope:` line deleted (older Claude Code versions do not print one) | yes |
| `claude-list.txt` | Claude Code 2.1.323 | real: `claude mcp list` | no, reference only (it health-checks every configured server, so `install` uses `get`) |
| `codex-list-ours.json`, `codex-list-foreign.json`, `codex-list-absent.json` | codex-cli 0.169.0 | real: `codex mcp list --json` (the `streamable_http` shape comes from an `example-docs` entry added with `--url`) | yes |
| `codex-list.txt` | codex-cli 0.169.0 | real: `codex mcp list` table | no, reference only |
| `gemini-list-ours.txt`, `gemini-list-foreign.txt`, `gemini-list-absent.txt` | gemini 0.68.0 | real: `gemini mcp list` from a trusted folder (stderr) | yes |
| `gemini-list-none.txt` | gemini 0.68.0 | real: `gemini mcp list` with no servers (stderr) | yes |
| `gemini-list-untrusted.txt` | gemini 0.68.0 | real: `gemini mcp list` from an untrusted folder, which is where `install` runs it (a temp directory): a two-line warning first, every server `Disabled` | yes |
| `gemini-list-extension.txt` | gemini 0.68.0 | hand-written from the format string in the CLI's bundled source: a server that comes from an extension (`<name> (from <extension>)`) and a `Disabled` one; no extension was installed to record it | yes |

Notes:

- `gemini mcp list` prints to stderr, so `detectEntry` reads stdout and stderr together.
- The gemini status word is a health check, not a configuration state: a registered `cardloom` printed
  `Disconnected` (trusted folder) or `Disabled` (untrusted folder), so detection never depends on it.
- Claude Code has no way to print a single server as JSON; `mcp get` prints `Command:` and `Args:` lines.
- `claude mcp get` and `claude mcp list` start the configured servers to check them, so `install` runs them
  once per agent from an empty temp directory.
