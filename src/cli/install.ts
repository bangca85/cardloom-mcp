import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { AGENT_INSTRUCTIONS } from '../config/agent-instructions.js';

// `cardloom-mcp install`: registers the server with each agent CLI found on PATH and puts the instruction
// block in that agent's global instructions file. A CLI (not the MCP server): printing to stdout is fine.

export type AgentId = 'claude' | 'codex' | 'gemini';
export const AGENT_IDS: readonly AgentId[] = ['claude', 'codex', 'gemini'];

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(cmd: string, args: string[], opts?: { cwd?: string }): Promise<CommandResult>;
}

export type EntryState = 'absent' | 'ours' | 'foreign';

type InstallFs = Pick<
  typeof import('node:fs'),
  'readFileSync' | 'writeFileSync' | 'mkdirSync' | 'existsSync' | 'renameSync' | 'realpathSync' | 'rmSync' | 'mkdtempSync' | 'statSync' | 'chmodSync'
>;

export const MARKER_START = '<!-- cardloom:start -->';
export const MARKER_END = '<!-- cardloom:end -->';

const SERVER_NAME = 'cardloom';
const PACKAGE = 'cardloom-mcp';

export class MarkerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MarkerError';
  }
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/**
 * Puts `block` between the cardloom markers. No markers: appended (an empty file just gets the block). One
 * start and one end, in order: only the text between them is replaced. Anything else (a lone, repeated or
 * reversed marker) throws and the caller keeps the file as it is. Text outside the markers is never altered.
 */
export function upsertInstructionBlock(existing: string, block: string): string {
  const starts = occurrences(existing, MARKER_START);
  const ends = occurrences(existing, MARKER_END);
  const wrapped = `${MARKER_START}\n${block.replace(/\s+$/, '')}\n${MARKER_END}`;
  if (starts === 0 && ends === 0) {
    if (existing === '') return `${wrapped}\n`;
    const gap = existing.endsWith('\n') ? '\n' : '\n\n';
    return `${existing}${gap}${wrapped}\n`;
  }
  if (starts !== 1 || ends !== 1) {
    throw new MarkerError(
      `expected one ${MARKER_START} and one ${MARKER_END}, found ${starts} and ${ends}`,
    );
  }
  const startAt = existing.indexOf(MARKER_START);
  const endAt = existing.indexOf(MARKER_END);
  if (endAt < startAt) throw new MarkerError(`${MARKER_END} comes before ${MARKER_START}`);
  return existing.slice(0, startAt) + wrapped + existing.slice(endAt + MARKER_END.length);
}

// ---------------------------------------------------------------- entry detection

/**
 * "Runs cardloom-mcp": the command is the `cardloom-mcp` binary, or an argument is the bare package name
 * (`npx -y cardloom-mcp`, `cardloom-mcp@1.2.0`). A path to a clone (`node /x/cardloom-mcp/dist/index.js`) or a
 * longer name (`cardloom-mcp-fork`) is not ours.
 */
function runsCardloomMcp(command: string, args: string[]): boolean {
  const bare = (token: string): boolean => token === PACKAGE || token.startsWith(`${PACKAGE}@`);
  const base = command.split(/[\\/]/).pop() ?? command;
  return bare(base) || args.some((a) => !/[\\/]/.test(a) && bare(a));
}

interface Inspection {
  state: EntryState;
  // foreign only: why the entry is kept as foreign when it is not simply "another command".
  // unreadable: its command could not be read. scope: claude reports it outside user scope. list: the agent's
  // server list could not be read, so an entry named cardloom may exist.
  reason?: 'unreadable' | 'scope' | 'list';
}

const ours = (command: string, args: string[]): Inspection =>
  runsCardloomMcp(command, args) ? { state: 'ours' } : { state: 'foreign' };
const unreadable: Inspection = { state: 'foreign', reason: 'unreadable' };

function firstLine(text: string): string {
  return text.split('\n').find((l) => l.trim() !== '')?.trim() ?? '';
}

function failed(what: string, r: CommandResult): Error {
  const detail = firstLine(r.stderr) || firstLine(r.stdout) || 'no output';
  return new Error(`${what} failed (exit ${r.code}): ${detail}`);
}

// `claude mcp get cardloom` prints the entry (exact name) with `Command:` / `Args:` lines, or "No MCP server named"
// and exit 1. `claude mcp list` health-checks every configured server, which is slow, so it is not used.
async function inspectClaude(runner: CommandRunner, cwd: string | undefined): Promise<Inspection> {
  const r = await runner.run('claude', ['mcp', 'get', SERVER_NAME], { cwd });
  if (r.code !== 0) {
    if (/No MCP server named/i.test(`${r.stdout}\n${r.stderr}`)) return { state: 'absent' };
    throw failed('claude mcp get cardloom', r);
  }
  if (firstLine(r.stdout) !== `${SERVER_NAME}:`) return unreadable;
  const command = /^\s*Command:\s*(.+?)\s*$/m.exec(r.stdout)?.[1];
  if (command === undefined) return unreadable;
  const args = (/^\s*Args:\s*(.+?)\s*$/m.exec(r.stdout)?.[1] ?? '').split(/\s+/).filter((a) => a !== '');
  // Registration is at user scope; scopes are separate stores (`claude mcp add --scope` takes local, user or
  // project), so only a user-scope entry can be "already registered". install runs this from an empty temp
  // directory, where `get` sees no local or project entry (a local one is keyed on the directory and would
  // shadow the user-scope one).
  const scope = /^\s*Scope:\s*(.+?)\s*$/m.exec(r.stdout)?.[1];
  if (scope === undefined) return { state: 'foreign', reason: 'scope' };
  if (/^User config/i.test(scope)) return ours(command, args);
  if (/^(Local|Project) config/i.test(scope)) {
    // A local/project entry that runs cardloom-mcp does not register it for every project: register at user scope.
    return runsCardloomMcp(command, args) ? { state: 'absent' } : { state: 'foreign', reason: 'scope' };
  }
  return { state: 'foreign', reason: 'scope' };
}

// `codex mcp list --json`: an array of {name, transport: {type, command, args}}; exact name match.
async function inspectCodex(runner: CommandRunner, cwd: string | undefined): Promise<Inspection> {
  const r = await runner.run('codex', ['mcp', 'list', '--json'], { cwd });
  if (r.code !== 0) throw failed('codex mcp list', r);
  let list: unknown;
  try {
    list = JSON.parse(r.stdout);
  } catch {
    throw new Error('codex mcp list --json did not print JSON');
  }
  if (!Array.isArray(list)) throw new Error('codex mcp list --json did not print a list');
  const entry = list.find((e): e is Record<string, unknown> => typeof e === 'object' && e !== null && (e as { name?: unknown }).name === SERVER_NAME);
  if (entry === undefined) return { state: 'absent' };
  const transport = entry['transport'] as { type?: unknown; command?: unknown; args?: unknown } | undefined;
  if (transport?.type !== 'stdio' || typeof transport.command !== 'string') return unreadable;
  const args = Array.isArray(transport.args) ? transport.args.filter((a): a is string => typeof a === 'string') : [];
  return ours(transport.command, args);
}

// `gemini mcp list` prints `Configured MCP servers:` and then `<indicator> <name>[ (from <ext>)]: <command> <args>
// (stdio) - <Status>` per server, or `No MCP servers configured.`; to stderr, possibly with colour codes. The
// text is parsed strictly because `gemini mcp add` overwrites an existing `cardloom`: "absent" is returned only
// for the no-servers text, or the header followed by lines that all parse and none of them named `cardloom`.
// Anything else (empty output, another header, a line this parser does not understand) is kept as unreadable.
const GEMINI_NO_SERVERS = 'No MCP servers configured.';
const GEMINI_HEADER = 'Configured MCP servers:';
const GEMINI_LINE = /^[^\s\w]+\s+(.+?): (.*)$/;
const GEMINI_STATUS = /\s+- (?:Connected|Connecting|Blocked|Disabled|Disconnected)\s*$/;
const unreadableList: Inspection = { state: 'foreign', reason: 'list' };

async function inspectGemini(runner: CommandRunner, cwd: string | undefined): Promise<Inspection> {
  const r = await runner.run('gemini', ['mcp', 'list'], { cwd });
  if (r.code !== 0) throw failed('gemini mcp list', r);
  // eslint-disable-next-line no-control-regex
  const text = `${r.stdout}\n${r.stderr}`.replace(/\u001b\[[0-9;]*m/g, '');
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  const mentionsCardloom = (l: string): boolean => /(^|[^\w-])cardloom(:| \()/.test(l);

  const header = lines.indexOf(GEMINI_HEADER);
  const noServers = lines.includes(GEMINI_NO_SERVERS);
  if (header === -1 && !noServers) return unreadableList;
  if (header !== -1 && noServers) return unreadableList;
  if (noServers) return lines.some(mentionsCardloom) ? unreadableList : { state: 'absent' };

  // A line before the header that names cardloom cannot be placed: keep the entry as it is.
  if (lines.slice(0, header).some(mentionsCardloom)) return unreadableList;
  const entries: Array<{ name: string; rest: string }> = [];
  for (const line of lines.slice(header + 1)) {
    const m = GEMINI_LINE.exec(line);
    if (m === null) return unreadableList;
    entries.push({ name: m[1] ?? '', rest: (m[2] ?? '').replace(GEMINI_STATUS, '') });
  }
  for (const { name, rest } of entries) {
    if (name.startsWith(`${SERVER_NAME} (from `)) return { state: 'foreign' };
    if (name !== SERVER_NAME) continue;
    const stdio = /^(.*) \(stdio\)$/.exec(rest);
    if (stdio === null) return unreadable;
    const [command, ...args] = (stdio[1] ?? '').split(/\s+/).filter((t) => t !== '');
    return command === undefined ? unreadable : ours(command, args);
  }
  return { state: 'absent' };
}

async function inspectEntry(agent: AgentId, runner: CommandRunner, cwd: string | undefined): Promise<Inspection> {
  if (agent === 'claude') return inspectClaude(runner, cwd);
  if (agent === 'codex') return inspectCodex(runner, cwd);
  return inspectGemini(runner, cwd);
}

/** Whether the agent already has a server named exactly `cardloom` that runs `cardloom-mcp`. Throws when the CLI fails. */
export async function detectEntry(agent: AgentId, runner: CommandRunner, opts: { cwd?: string } = {}): Promise<EntryState> {
  return (await inspectEntry(agent, runner, opts.cwd)).state;
}

// ---------------------------------------------------------------- install

const REGISTER: Record<AgentId, string[]> = {
  claude: ['mcp', 'add', '--scope', 'user', SERVER_NAME, '--', 'npx', '-y', PACKAGE],
  codex: ['mcp', 'add', SERVER_NAME, '--', 'npx', '-y', PACKAGE],
  gemini: ['mcp', 'add', '--scope', 'user', SERVER_NAME, 'npx', '-y', PACKAGE],
};

export interface InstallEnv {
  pathDirs: string[];
  home: string;
  codexHome?: string;
}

export interface InstallOptions {
  agents?: AgentId[];
  yes: boolean;
}

function instructionsPath(agent: AgentId, env: InstallEnv): string {
  if (agent === 'claude') return path.join(env.home, '.claude', 'CLAUDE.md');
  if (agent === 'codex') return path.join(env.codexHome ?? path.join(env.home, '.codex'), 'AGENTS.md');
  return path.join(env.home, '.gemini', 'GEMINI.md');
}

function findOnPath(agent: AgentId, pathDirs: string[], fs: InstallFs): boolean {
  const names = process.platform === 'win32' ? [agent, `${agent}.exe`, `${agent}.cmd`] : [agent];
  return pathDirs.some((dir) => dir !== '' && names.some((n) => fs.existsSync(path.join(dir, n))));
}

type InstructionsPlan =
  | { kind: 'write'; verb: 'create' | 'add to' | 'update'; content: string }
  | { kind: 'current' }
  | { kind: 'hand-written' };

// A file whose Knowledge Hub section was pasted by hand (no markers) is left alone: a second copy only costs tokens.
const HEADING = AGENT_INSTRUCTIONS.split('\n')[0] ?? '';

function planInstructions(file: string, fs: InstallFs): InstructionsPlan {
  if (!fs.existsSync(file)) return { kind: 'write', verb: 'create', content: upsertInstructionBlock('', AGENT_INSTRUCTIONS) };
  const existing = fs.readFileSync(file, 'utf8');
  const marked = existing.includes(MARKER_START) || existing.includes(MARKER_END);
  if (!marked && existing.includes(HEADING)) return { kind: 'hand-written' };
  const content = upsertInstructionBlock(existing, AGENT_INSTRUCTIONS);
  if (content === existing) return { kind: 'current' };
  return { kind: 'write', verb: marked ? 'update' : 'add to', content };
}

/**
 * Writes next to the target and renames over it, so a failed write never truncates the user's file. A symlinked
 * target (dotfile managers) stays a symlink: the rename lands on the file it points to. An existing file's
 * permissions are kept. The temp file is removed on failure.
 */
function writeFileAtomically(file: string, content: string, fs: InstallFs): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const exists = fs.existsSync(file);
  const target = exists ? fs.realpathSync(file) : file;
  const tmp = `${target}.cardloom-tmp`;
  try {
    // The rename replaces the inode, so the file's permissions (a 0600 instruction file) are carried over by hand.
    const mode = exists ? fs.statSync(target).mode & 0o7777 : undefined;
    fs.writeFileSync(tmp, content);
    if (mode !== undefined) fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // best effort: the original file is intact either way
    }
    throw err;
  }
}

function describePlan(plan: InstructionsPlan, file: string, applied: boolean): string {
  if (plan.kind === 'current') return `instructions already up to date: ${file}`;
  if (plan.kind === 'hand-written') return `instructions left alone: ${file} already has a Knowledge Hub section; wrap it in ${MARKER_START} / ${MARKER_END} or delete it to let install keep it current`;
  const what =
    plan.verb === 'create' ? ['created', 'create'] : plan.verb === 'update' ? ['updated', 'update'] : ['added to', 'add to'];
  return applied ? `instructions ${what[0]}: ${file}` : `would ${what[1]} instructions: ${file}`;
}

const SCOPE_MESSAGE = 'cardloom found outside user scope; left unchanged';
const FOREIGN_MESSAGE = 'existing cardloom entry uses another command; left unchanged';
const LIST_MESSAGE = "could not read gemini's server list; left unchanged";

interface AgentOutcome {
  lines: string[];
  ok: boolean;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function installAgent(
  agent: AgentId,
  env: InstallEnv,
  yes: boolean,
  runner: CommandRunner,
  fs: InstallFs,
  detectCwd: string,
): Promise<AgentOutcome> {
  const lines: string[] = [agent];
  const say = (text: string): number => lines.push(`  ${text}`);
  const registerCommand = `${agent} ${REGISTER[agent].join(' ')}`;
  const file = instructionsPath(agent, env);
  try {
    const inspected = await inspectEntry(agent, runner, detectCwd);
    if (inspected.state === 'foreign') {
      if (inspected.reason === 'scope') say(SCOPE_MESSAGE);
      else if (inspected.reason === 'list') say(LIST_MESSAGE);
      else say(FOREIGN_MESSAGE + (inspected.reason === 'unreadable' ? ' (its command could not be read, so it is treated as another command)' : ''));
      say('instructions not written for this agent');
      return { lines, ok: true };
    }

    if (inspected.state === 'ours') {
      say('server already registered');
    } else if (!yes) {
      say(`would register: ${registerCommand}`);
    } else {
      const r = await runner.run(agent, REGISTER[agent]);
      if (r.code !== 0) {
        say(`registering failed: ${registerCommand} exited ${r.code}: ${firstLine(r.stderr) || firstLine(r.stdout) || 'no output'}`);
        say('instructions not written');
        return { lines, ok: false };
      }
      say(`registered: ${registerCommand}`);
    }

    let plan: InstructionsPlan;
    try {
      plan = planInstructions(file, fs);
    } catch (err) {
      say(`cannot update ${file}: ${errorMessage(err)}; fix the markers and run install again (file left untouched)`);
      return { lines, ok: false };
    }
    if (yes && plan.kind === 'write') {
      writeFileAtomically(file, plan.content, fs);
    }
    say(describePlan(plan, file, yes));
    return { lines, ok: true };
  } catch (err) {
    say(`failed: ${errorMessage(err)}`);
    return { lines, ok: false };
  }
}

const RERUN = 'npx -y cardloom-mcp install --yes';

export async function runInstall(
  env: InstallEnv,
  opts: InstallOptions,
  runner: CommandRunner,
  fs: InstallFs,
): Promise<{ lines: string[]; exitCode: 0 | 1 }> {
  const wanted = opts.agents ?? AGENT_IDS;
  const found = AGENT_IDS.filter((a) => wanted.includes(a) && findOnPath(a, env.pathDirs, fs));
  if (found.length === 0) {
    const looked = AGENT_IDS.filter((a) => wanted.includes(a));
    return { lines: [`No supported agent CLI found (looked for ${looked.join(', ')}).`], exitCode: 1 };
  }

  const lines: string[] = [opts.yes ? `Installing cardloom-mcp for ${found.join(', ')}.` : `Plan for ${found.join(', ')} (nothing is changed).`, ''];
  const failedAgents: AgentId[] = [];
  // Detection runs from a fresh empty directory: `claude mcp get` and `gemini mcp list` then show only user-scope
  // entries, never a local or project one keyed on the directory they happen to run in.
  let detectCwd: string;
  try {
    detectCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cardloom-install-'));
  } catch (err) {
    return { lines: [`Cannot create a temporary directory to check the agents from: ${errorMessage(err)}`], exitCode: 1 };
  }
  try {
    for (const agent of found) {
      const outcome = await installAgent(agent, env, opts.yes, runner, fs, detectCwd);
      lines.push(...outcome.lines, '');
      if (!outcome.ok) failedAgents.push(agent);
    }
  } finally {
    try {
      fs.rmSync(detectCwd, { recursive: true, force: true });
    } catch {
      // best effort: an empty directory in the temp folder is harmless
    }
  }

  if (!opts.yes) {
    lines.push(`Nothing changed. Run \`${RERUN}\` to apply this plan.`);
    return { lines, exitCode: 0 };
  }
  if (failedAgents.length > 0) {
    lines.push(
      `${failedAgents.length} of ${found.length} failed (${failedAgents.join(', ')}). Fix the problem above and run \`${RERUN}\` again: agents that are already set up are not changed twice.`,
    );
    return { lines, exitCode: 1 };
  }
  lines.push('Done. Restart your agent so it picks up the server and the instructions.');
  return { lines, exitCode: 0 };
}

export const INSTALL_USAGE = 'Usage: install [--yes] [--agent claude|codex|gemini]...';

/** `help` is set only when `--help` / `-h` was given: the caller prints the usage and exits 0. */
export function parseInstallArgs(argv: string[]): { yes: boolean; agents?: AgentId[]; help?: true } | null {
  let yes = false;
  let agents: AgentId[] | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') return { yes, agents, help: true };
    if (a === '--yes') yes = true;
    else if (a === '--agent') {
      const id = argv[++i];
      if (id === undefined || !(AGENT_IDS as readonly string[]).includes(id)) return null;
      (agents ??= []).push(id as AgentId);
    } else return null;
  }
  return { yes, agents };
}

/** Runs a command without a shell; an unstartable command is exit 127. */
export function createCommandRunner(timeoutMs = 120_000): CommandRunner {
  return {
    run(cmd, args, opts) {
      return new Promise((resolve) => {
        let stdout = '';
        let stderr = '';
        let settled = false;
        const done = (code: number): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ code, stdout, stderr });
        };
        const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32', cwd: opts?.cwd });
        const timer = setTimeout(() => {
          stderr += `timed out after ${timeoutMs / 1000}s`;
          child.kill();
          done(124);
        }, timeoutMs);
        child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
        child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
        child.on('error', (err) => {
          stderr += err.message;
          done(127);
        });
        child.on('close', (code) => done(code ?? 1));
      });
    },
  };
}
