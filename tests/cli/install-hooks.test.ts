import * as nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MARKER_START, parseInstallArgs, planHooks, runInstall, writeFileAtomically } from '../../src/cli/install.js';
import type { CommandRunner } from '../../src/cli/install.js';

const HOOK_COMMAND = 'npx -y cardloom-mcp context';
const ENTRY = { type: 'command', command: HOOK_COMMAND };

let root: string;
let home: string;
let settings: string;

beforeEach(() => {
  root = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'cardloom-hooks-'));
  home = path.join(root, 'home');
  nodeFs.mkdirSync(home);
  settings = path.join(home, '.claude', 'settings.json');
});
afterEach(() => {
  nodeFs.rmSync(root, { recursive: true, force: true });
});

function recordingRunner(): CommandRunner & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    async run(cmd, args) {
      calls.push([cmd, ...args]);
      return { code: 1, stdout: '', stderr: 'no agent CLI may be run by --hooks alone' };
    },
  };
}

const env = (): { pathDirs: string[]; home: string } => ({ pathDirs: [], home });
const hooksOnly = (yes: boolean) => ({ yes, hooks: true as const });
const readJson = (file = settings): unknown => JSON.parse(nodeFs.readFileSync(file, 'utf8'));
const seedSettings = (text: string): void => {
  nodeFs.mkdirSync(path.dirname(settings), { recursive: true });
  nodeFs.writeFileSync(settings, text);
};

describe('install --hooks plan (no --yes)', () => {
  it('changes nothing, creates nothing in HOME, runs no agent CLI, exit 0', async () => {
    const runner = recordingRunner();
    const res = await runInstall(env(), hooksOnly(false), runner, nodeFs);
    expect(res.exitCode).toBe(0);
    expect(runner.calls).toEqual([]);
    expect(nodeFs.readdirSync(home)).toEqual([]);
    const text = res.lines.join('\n');
    expect(text).toContain(settings);
    expect(text).toContain(HOOK_COMMAND);
    expect(text).toContain('SessionStart');
    expect(text).toContain('Nothing changed');
    expect(text).toContain('--yes');
    expect(text).toMatch(/codex|gemini/);
    expect(text).toContain('`npx -y cardloom-mcp install --hooks --yes`');
  });

  it('an existing file is not touched either', async () => {
    const original = '{\n  "model": "opus"\n}\n';
    seedSettings(original);
    const res = await runInstall(env(), hooksOnly(false), recordingRunner(), nodeFs);
    expect(res.exitCode).toBe(0);
    expect(nodeFs.readFileSync(settings, 'utf8')).toBe(original);
    expect(nodeFs.readdirSync(path.dirname(settings))).toEqual(['settings.json']);
  });
});

describe('install --hooks --yes', () => {
  it('on a missing file creates the settings file with exactly one hook', async () => {
    const runner = recordingRunner();
    const res = await runInstall(env(), hooksOnly(true), runner, nodeFs);
    expect(res.exitCode).toBe(0);
    expect(runner.calls).toEqual([]);
    expect(nodeFs.readFileSync(settings, 'utf8')).toBe(
      `${JSON.stringify({ hooks: { SessionStart: [{ hooks: [ENTRY] }] } }, null, 2)}\n`,
    );
    // hook-only: no MCP registration, no instruction files anywhere under HOME
    expect(nodeFs.readdirSync(path.join(home, '.claude'))).toEqual(['settings.json']);
    expect(nodeFs.readdirSync(home)).toEqual(['.claude']);
    expect(res.lines.join('\n')).toContain('Restart');
  });

  it('a second run does not duplicate the hook and does not rewrite the file', async () => {
    await runInstall(env(), hooksOnly(true), recordingRunner(), nodeFs);
    const first = nodeFs.readFileSync(settings, 'utf8');
    const before = nodeFs.statSync(settings).mtimeMs;
    const res = await runInstall(env(), hooksOnly(true), recordingRunner(), nodeFs);
    expect(res.exitCode).toBe(0);
    expect(nodeFs.readFileSync(settings, 'utf8')).toBe(first);
    expect(nodeFs.statSync(settings).mtimeMs).toBe(before);
    expect(first.split('cardloom-mcp context').length - 1).toBe(1);
    expect(res.lines.join('\n')).toContain('already');
  });

  it('recognises an entry written by hand (any command containing "cardloom-mcp context")', async () => {
    const original = `${JSON.stringify({ hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'cardloom-mcp context --max-cards 3' }] }] } }, null, 2)}\n`;
    seedSettings(original);
    const res = await runInstall(env(), hooksOnly(true), recordingRunner(), nodeFs);
    expect(res.exitCode).toBe(0);
    expect(nodeFs.readFileSync(settings, 'utf8')).toBe(original);
  });

  it('keeps unrelated keys and hooks and appends one group (2-space indent, trailing newline)', async () => {
    const original = {
      model: 'opus',
      permissions: { allow: ['Bash(npm test)', 'Read'], deny: [] },
      env: { A: '1' },
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] }],
        SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'echo hello' }] }],
      },
    };
    seedSettings(`${JSON.stringify(original, null, 2)}\n`);
    const res = await runInstall(env(), hooksOnly(true), recordingRunner(), nodeFs);
    expect(res.exitCode).toBe(0);
    const expected = structuredClone(original);
    expected.hooks.SessionStart.push({ hooks: [ENTRY] } as never);
    expect(nodeFs.readFileSync(settings, 'utf8')).toBe(`${JSON.stringify(expected, null, 2)}\n`);
  });

  it('creates hooks / SessionStart when only other keys exist', async () => {
    seedSettings('{\n  "model": "opus"\n}\n');
    await runInstall(env(), hooksOnly(true), recordingRunner(), nodeFs);
    expect(readJson()).toEqual({ model: 'opus', hooks: { SessionStart: [{ hooks: [ENTRY] }] } });
  });

  it('adds SessionStart next to other hook events', async () => {
    seedSettings('{\n  "hooks": {\n    "Stop": []\n  }\n}\n');
    await runInstall(env(), hooksOnly(true), recordingRunner(), nodeFs);
    expect(readJson()).toEqual({ hooks: { Stop: [], SessionStart: [{ hooks: [ENTRY] }] } });
  });

  it.each([
    ['4 spaces', '    ', 4],
    ['a tab', '\t', 'tab'],
    ['2 spaces', '  ', 2],
  ] as const)('keeps the indentation of the file (%s)', async (_label, unit) => {
    const original = { model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo bye' }] }] } };
    seedSettings(`${JSON.stringify(original, null, unit)}\n`);
    await runInstall(env(), hooksOnly(true), recordingRunner(), nodeFs);
    const expected = { ...original, hooks: { ...original.hooks, SessionStart: [{ hooks: [ENTRY] }] } };
    expect(nodeFs.readFileSync(settings, 'utf8')).toBe(`${JSON.stringify(expected, null, unit)}\n`);
  });

  it('keeps a missing trailing newline missing', async () => {
    seedSettings(JSON.stringify({ model: 'opus' }, null, 2));
    await runInstall(env(), hooksOnly(true), recordingRunner(), nodeFs);
    const text = nodeFs.readFileSync(settings, 'utf8');
    expect(text.endsWith('}')).toBe(true);
    expect(readJson()).toMatchObject({ model: 'opus' });
  });

  it('keeps Windows line endings', async () => {
    seedSettings(JSON.stringify({ model: 'opus' }, null, 2).replace(/\n/g, '\r\n') + '\r\n');
    await runInstall(env(), hooksOnly(true), recordingRunner(), nodeFs);
    const text = nodeFs.readFileSync(settings, 'utf8');
    expect(text).toContain('\r\n');
    expect(text.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('a one-line file gets the default 2-space indentation', async () => {
    seedSettings('{"model":"opus"}');
    await runInstall(env(), hooksOnly(true), recordingRunner(), nodeFs);
    expect(nodeFs.readFileSync(settings, 'utf8')).toBe(
      JSON.stringify({ model: 'opus', hooks: { SessionStart: [{ hooks: [ENTRY] }] } }, null, 2),
    );
  });

  it.each([
    ['not JSON', '{ "hooks": { oops'],
    ['a trailing comma', '{ "model": "opus", }'],
    ['an empty file', ''],
    ['a comment', '{ // c\n "model": "opus" }'],
    ['an array', '[1, 2]'],
    ['null', 'null'],
    ['hooks that is a string', '{ "hooks": "nope" }'],
    ['hooks that is an array', '{ "hooks": [] }'],
    ['SessionStart that is an object', '{ "hooks": { "SessionStart": {} } }'],
  ])('refuses %s: nothing changes, exit 1, a message names the file', async (_label, text) => {
    seedSettings(text);
    const res = await runInstall(env(), hooksOnly(true), recordingRunner(), nodeFs);
    expect(res.exitCode).toBe(1);
    expect(nodeFs.readFileSync(settings, 'utf8')).toBe(text);
    expect(nodeFs.readdirSync(path.dirname(settings))).toEqual(['settings.json']);
    expect(res.lines.join('\n')).toContain(settings);
  });

  it('the plan (no --yes) also reports an unreadable file, exit 1, nothing changed', async () => {
    seedSettings('{ nope');
    const res = await runInstall(env(), hooksOnly(false), recordingRunner(), nodeFs);
    expect(res.exitCode).toBe(1);
    expect(nodeFs.readFileSync(settings, 'utf8')).toBe('{ nope');
  });

  it('a symlinked settings file stays a symlink and the real file is updated', async () => {
    const real = path.join(root, 'dotfiles', 'settings.json');
    nodeFs.mkdirSync(path.dirname(real), { recursive: true });
    nodeFs.writeFileSync(real, '{\n  "model": "opus"\n}\n');
    nodeFs.mkdirSync(path.dirname(settings), { recursive: true });
    nodeFs.symlinkSync(real, settings);
    const res = await runInstall(env(), hooksOnly(true), recordingRunner(), nodeFs);
    expect(res.exitCode).toBe(0);
    expect(nodeFs.lstatSync(settings).isSymbolicLink()).toBe(true);
    expect(nodeFs.realpathSync(settings)).toBe(nodeFs.realpathSync(real));
    expect(readJson(real)).toEqual({ model: 'opus', hooks: { SessionStart: [{ hooks: [ENTRY] }] } });
    expect(nodeFs.readdirSync(path.dirname(real))).toEqual(['settings.json']);
  });

  it('keeps the mode of an existing 0600 file', async () => {
    seedSettings('{\n  "model": "opus"\n}\n');
    nodeFs.chmodSync(settings, 0o600);
    await runInstall(env(), hooksOnly(true), recordingRunner(), nodeFs);
    expect(nodeFs.statSync(settings).mode & 0o777).toBe(0o600);
    expect(readJson()).toHaveProperty('hooks');
  });

  it('a failed rename leaves the original intact and removes the temp file, exit 1', async () => {
    const original = '{\n  "model": "opus"\n}\n';
    seedSettings(original);
    const failing = {
      ...nodeFs,
      renameSync: () => {
        throw new Error('EXDEV');
      },
    } as unknown as typeof nodeFs;
    const res = await runInstall(env(), hooksOnly(true), recordingRunner(), failing);
    expect(res.exitCode).toBe(1);
    expect(nodeFs.readFileSync(settings, 'utf8')).toBe(original);
    expect(nodeFs.readdirSync(path.dirname(settings))).toEqual(['settings.json']);
    expect(res.lines.join('\n')).toContain('EXDEV');
  });

  it('uses the injected home only: ~/.claude/settings.json under it, no other location', async () => {
    await runInstall({ pathDirs: [], home, codexHome: path.join(root, 'codex') }, hooksOnly(true), recordingRunner(), nodeFs);
    expect(nodeFs.existsSync(path.join(root, 'codex'))).toBe(false);
    expect(nodeFs.readdirSync(root).sort()).toEqual(['home']);
  });
});

describe('install --hooks together with the normal run', () => {
  const codexAbsent: CommandRunner = {
    async run(cmd, args) {
      if (cmd === 'codex' && args[1] === 'list') return { code: 0, stdout: '[]', stderr: '' };
      if (cmd === 'codex' && args[1] === 'add') return { code: 0, stdout: '', stderr: '' };
      return { code: 1, stdout: '', stderr: 'unexpected' };
    },
  };

  it('--agent plus --hooks registers the agent, writes its instructions and adds the hook', async () => {
    const bin = path.join(root, 'bin');
    nodeFs.mkdirSync(bin);
    nodeFs.writeFileSync(path.join(bin, 'codex'), '');
    const res = await runInstall({ pathDirs: [bin], home }, { yes: true, agents: ['codex'], hooks: true }, codexAbsent, nodeFs);
    expect(res.exitCode).toBe(0);
    expect(nodeFs.readFileSync(path.join(home, '.codex', 'AGENTS.md'), 'utf8')).toContain(MARKER_START);
    expect(readJson()).toEqual({ hooks: { SessionStart: [{ hooks: [ENTRY] }] } });
    const text = res.lines.join('\n');
    expect(text).toContain('codex');
    expect(text).toContain(settings);
  });

  it('without --yes it plans both and changes neither', async () => {
    const bin = path.join(root, 'bin');
    nodeFs.mkdirSync(bin);
    nodeFs.writeFileSync(path.join(bin, 'codex'), '');
    const res = await runInstall({ pathDirs: [bin], home }, { yes: false, agents: ['codex'], hooks: true }, codexAbsent, nodeFs);
    expect(res.exitCode).toBe(0);
    expect(nodeFs.readdirSync(home)).toEqual([]);
    expect(res.lines.join('\n')).toContain('would add');
    expect(res.lines.join('\n')).toContain('would register');
    expect(res.lines.join('\n')).toContain('`npx -y cardloom-mcp install --agent codex --hooks --yes`');
  });

  it('without --hooks the settings file is never touched', async () => {
    const bin = path.join(root, 'bin');
    nodeFs.mkdirSync(bin);
    nodeFs.writeFileSync(path.join(bin, 'codex'), '');
    await runInstall({ pathDirs: [bin], home }, { yes: true, agents: ['codex'] }, codexAbsent, nodeFs);
    expect(nodeFs.existsSync(settings)).toBe(false);
  });

  it('a broken settings file fails the run (exit 1) but the agent setup still completes', async () => {
    const bin = path.join(root, 'bin');
    nodeFs.mkdirSync(bin);
    nodeFs.writeFileSync(path.join(bin, 'codex'), '');
    seedSettings('{ nope');
    const res = await runInstall({ pathDirs: [bin], home }, { yes: true, agents: ['codex'], hooks: true }, codexAbsent, nodeFs);
    expect(res.exitCode).toBe(1);
    expect(nodeFs.readFileSync(path.join(home, '.codex', 'AGENTS.md'), 'utf8')).toContain(MARKER_START);
    expect(nodeFs.readFileSync(settings, 'utf8')).toBe('{ nope');
  });
});

describe('planHooks', () => {
  it('missing file: a write that creates it', () => {
    const plan = planHooks(settings, nodeFs);
    expect(plan).toEqual({
      kind: 'write',
      verb: 'create',
      content: `${JSON.stringify({ hooks: { SessionStart: [{ hooks: [ENTRY] }] } }, null, 2)}\n`,
    });
    expect(nodeFs.existsSync(settings)).toBe(false);
  });

  it('present entry: current', () => {
    seedSettings(`${JSON.stringify({ hooks: { SessionStart: [{ hooks: [ENTRY] }] } })}\n`);
    expect(planHooks(settings, nodeFs)).toEqual({ kind: 'current' });
  });

  it('other file: a write that updates it', () => {
    seedSettings('{}\n');
    expect(planHooks(settings, nodeFs)).toMatchObject({ kind: 'write', verb: 'update' });
  });

  it('invalid JSON: invalid with a message, never throws', () => {
    seedSettings('{');
    const plan = planHooks(settings, nodeFs);
    expect(plan.kind).toBe('invalid');
    expect(plan).toHaveProperty('message');
  });
});

describe('writeFileAtomically is shared', () => {
  it('is exported from install.ts and writes through a temp file', () => {
    const file = path.join(root, 'x', 'y.txt');
    writeFileAtomically(file, 'hello', nodeFs);
    expect(nodeFs.readFileSync(file, 'utf8')).toBe('hello');
    expect(nodeFs.readdirSync(path.dirname(file))).toEqual(['y.txt']);
  });
});

describe('parseInstallArgs --hooks', () => {
  it('--hooks alone', () => {
    expect(parseInstallArgs(['--hooks'])).toEqual({ yes: false, agents: undefined, hooks: true });
  });
  it('combines with --yes and --agent in any order', () => {
    expect(parseInstallArgs(['--hooks', '--yes', '--agent', 'claude'])).toEqual({ yes: true, agents: ['claude'], hooks: true });
    expect(parseInstallArgs(['--agent', 'codex', '--yes', '--hooks'])).toEqual({ yes: true, agents: ['codex'], hooks: true });
  });
  it('without it the result has no hooks key', () => {
    expect(parseInstallArgs(['--yes'])).toEqual({ yes: true, agents: undefined });
    expect('hooks' in (parseInstallArgs(['--yes']) ?? {})).toBe(false);
  });
  it('--help still wins', () => {
    expect(parseInstallArgs(['--hooks', '--help'])?.help).toBe(true);
  });
  it('rejects a value after --hooks', () => {
    expect(parseInstallArgs(['--hooks=1'])).toBeNull();
  });
});
