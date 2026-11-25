import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..', '..');
const launcher = join(root, 'bin', 'cardloom-mcp.mjs');
// The launcher imports from dist/; CI builds before testing. Without a build there is nothing to launch.
const built = existsSync(join(root, 'dist', 'cli', 'install.js'));

let sandbox: string;
let home: string;
let emptyBin: string;

function launch(args: string[], pathDirs: string[], extraEnv: Record<string, string> = {}) {
  const res = spawnSync(process.execPath, [launcher, ...args], {
    // No KNOWLEDGE_STORE_PATH / INDEX_DB_PATH / CODEX_HOME: the launcher must not reach for the real ones.
    env: { PATH: pathDirs.join(':'), HOME: home, ...extraEnv },
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

describe.skipIf(!built)('launcher usage and install', () => {
  beforeAll(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'cardloom-launcher-'));
    home = join(sandbox, 'home');
    emptyBin = join(sandbox, 'bin');
    mkdirSync(home);
    mkdirSync(emptyBin);
  });
  afterAll(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it.each([['--help'], ['-h']])('%s prints the usage (with install) to stderr and exits 0', (flag) => {
    const res = launch([flag], [emptyBin]);
    expect(res.code).toBe(0);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('cardloom-mcp install');
    expect(res.stderr).toContain('cardloom-mcp doctor');
    expect(res.stderr).toContain('cardloom-mcp triage');
    expect(res.stderr).toContain('cardloom-mcp report');
    expect(res.stderr).toContain('cardloom-mcp upgrade-check');
    expect(res.stderr).toContain('cardloom-mcp reconfirm');
    expect(res.stderr).toContain('cardloom-mcp gaps');
    expect(res.stderr).toContain('cardloom-mcp context');
    expect(readdirSync(home)).toEqual([]);
  });

  it('an unknown argument prints the usage to stderr, exits 1 and creates nothing', () => {
    const res = launch(['bogus'], [emptyBin]);
    expect(res.code).toBe(1);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('Usage');
    expect(readdirSync(home)).toEqual([]);
  });

  it('doctor with an unknown flag prints the doctor usage to stderr, exits 1 and does not run doctor', () => {
    const res = launch(['doctor', '--bogus'], [emptyBin]);
    expect(res.code).toBe(1);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('Usage: doctor');
    expect(readdirSync(home)).toEqual([]);
  });

  it('install with no agent CLI on PATH says so, exits 1 and does not create ~/.cardloom', () => {
    const res = launch(['install', '--yes'], [emptyBin]);
    expect(res.code).toBe(1);
    expect(`${res.stdout}${res.stderr}`).toContain('No supported agent CLI found (looked for claude, codex, gemini).');
    expect(readdirSync(home)).toEqual([]);
  });

  it.each([
    ['install', '--help', 'Usage: install'],
    ['install', '-h', 'Usage: install'],
    ['doctor', '--help', 'Usage: doctor'],
    ['doctor', '-h', 'Usage: doctor'],
    ['triage', '--help', 'Usage: triage'],
    ['triage', '-h', 'Usage: triage'],
    ['report', '--help', 'Usage: report'],
    ['report', '-h', 'Usage: report'],
    ['upgrade-check', '--help', 'Usage: upgrade-check'],
    ['upgrade-check', '-h', 'Usage: upgrade-check'],
    ['reconfirm', '--help', 'Usage: reconfirm'],
    ['reconfirm', '-h', 'Usage: reconfirm'],
    ['gaps', '--help', 'Usage: gaps'],
    ['gaps', '-h', 'Usage: gaps'],
    ['context', '--help', 'Usage: context'],
    ['context', '-h', 'Usage: context'],
  ])('%s %s prints that subcommand usage to stdout and exits 0', (sub, flag, usage) => {
    const res = launch([sub as string, flag as string], [emptyBin]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain(usage);
    expect(res.stderr).toBe('');
    expect(readdirSync(home)).toEqual([]);
  });

  it.each([[['report', '--days', '0']], [['report', '--days', 'x']], [['report', '--bogus']]])(
    '%j prints the report usage to stderr, exits 1 and creates nothing',
    (args) => {
      const res = launch(args as string[], [emptyBin]);
      expect(res.code).toBe(1);
      expect(res.stdout).toBe('');
      expect(res.stderr).toContain('Usage: report');
      expect(readdirSync(home)).toEqual([]);
    },
  );

  it.each([[['upgrade-check']], [['upgrade-check', '--bogus']], [['upgrade-check', '--to', 'next']]])(
    '%j prints the upgrade-check usage to stderr, exits 1 and creates nothing',
    (args) => {
      const res = launch(args as string[], [emptyBin]);
      expect(res.code).toBe(1);
      expect(res.stdout).toBe('');
      expect(res.stderr).toContain('Usage: upgrade-check');
      expect(readdirSync(home)).toEqual([]);
    },
  );

  it.each([
    [['reconfirm']],
    [['reconfirm', '--bogus']],
    [['reconfirm', '--confirm']],
    [['reconfirm', '--confirm', 'pattern-a']],
    [['reconfirm', '--stale', '--confirm', `pattern-a@${'a'.repeat(64)}`]],
  ])('%j prints the reconfirm usage to stderr, exits 1 and creates nothing', (args) => {
    const res = launch(args as string[], [emptyBin]);
    expect(res.code).toBe(1);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('Usage: reconfirm');
    expect(readdirSync(home)).toEqual([]);
  });

  it.each([[['gaps', '--bogus']], [['gaps', 'extra']], [['gaps', '--days', '3']]])(
    '%j prints the gaps usage to stderr, exits 1 and creates nothing',
    (args) => {
      const res = launch(args as string[], [emptyBin]);
      expect(res.code).toBe(1);
      expect(res.stdout).toBe('');
      expect(res.stderr).toContain('Usage: gaps');
      expect(readdirSync(home)).toEqual([]);
    },
  );

  it('gaps on a home with no telemetry says so, exits 0 and creates nothing', () => {
    const res = launch(['gaps'], [emptyBin]);
    expect(res.code).toBe(0);
    expect(res.stdout).toBe('No telemetry yet. Set CARDLOOM_TELEMETRY=local to start recording.\n');
    expect(res.stderr).toBe('');
    expect(readdirSync(home)).toEqual([]);
  });

  it('gaps with INDEX_DB_PATH inside the store says telemetry is not recorded, exits 0 and creates nothing', () => {
    const store = join(home, 'kstore');
    const res = launch(['gaps'], [emptyBin], { KNOWLEDGE_STORE_PATH: store, INDEX_DB_PATH: join(store, '.metadata', 'index.db') });
    expect(res.code).toBe(0);
    expect(res.stdout).toBe(
      'Telemetry is not recorded while the index is inside the knowledge store. Set INDEX_DB_PATH or CARDLOOM_TELEMETRY_PATH outside it.\n',
    );
    expect(res.stderr).toBe('');
    expect(readdirSync(home)).toEqual([]);
  });

  it('reconfirm --stale on a home with no store says there is nothing and creates nothing', () => {
    const res = launch(['reconfirm', '--stale'], [emptyBin]);
    expect(res.code).toBe(0);
    expect(res.stdout).toBe('No stale cards.\n');
    expect(res.stderr).toBe('');
    expect(readdirSync(home)).toEqual([]);
  });

  it.each([
    [['context', '--bogus']],
    [['context', 'extra']],
    [['context', '--project']],
    [['context', '--project', 'not a key!']],
    [['context', '--max-cards', '0']],
    [['context', '--max-estimated-tokens', 'x']],
  ])('%j prints the context usage to stderr, exits 1 and creates nothing', (args) => {
    const res = launch(args as string[], [emptyBin]);
    expect(res.code).toBe(1);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('Usage: context');
    expect(readdirSync(home)).toEqual([]);
  });

  it('context on a home with no index prints nothing, exits 0 and creates nothing (not even ~/.cardloom)', () => {
    const cwd = join(sandbox, 'project');
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, '.knowledge-map.yaml'), 'project: acme/api\n');
    const res = spawnSync(process.execPath, [launcher, 'context'], {
      env: { PATH: emptyBin, HOME: home },
      cwd,
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('');
    expect(res.stderr).toBe('');
    expect(readdirSync(home)).toEqual([]);
  });

  it('install --hooks writes only ~/.claude/settings.json of the temp home (and only with --yes)', () => {
    const hookHome = mkdtempSync(join(sandbox, 'hook-home-'));
    const run = (args: string[]) =>
      spawnSync(process.execPath, [launcher, ...args], { env: { PATH: emptyBin, HOME: hookHome }, encoding: 'utf8', timeout: 30_000 });
    const plan = run(['install', '--hooks']);
    expect(plan.status).toBe(0);
    expect(plan.stdout).toContain('npx -y cardloom-mcp context');
    expect(readdirSync(hookHome)).toEqual([]);
    const applied = run(['install', '--hooks', '--yes']);
    expect(applied.status).toBe(0);
    expect(readdirSync(hookHome)).toEqual(['.claude']);
    expect(readdirSync(join(hookHome, '.claude'))).toEqual(['settings.json']);
    expect(JSON.parse(readFileSync(join(hookHome, '.claude', 'settings.json'), 'utf8'))).toEqual({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'npx -y cardloom-mcp context' }] }] },
    });
  });

  it('install with bad arguments prints the install usage and exits 1', () => {
    const res = launch(['install', '--force'], [emptyBin]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('Usage: install');
    expect(readdirSync(home)).toEqual([]);
  });

  describe.skipIf(process.platform === 'win32')('with a stub claude on PATH', () => {
    let stubBin: string;
    let log: string;

    beforeAll(() => {
      stubBin = join(sandbox, 'stub-bin');
      log = join(sandbox, 'claude-calls.log');
      mkdirSync(stubBin);
      const stub = join(stubBin, 'claude');
      writeFileSync(
        stub,
        [
          '#!/bin/sh',
          `echo "$@" >> "${log}"`,
          'if [ "$2" = "get" ]; then echo \'No MCP server named "cardloom". Configured servers: cardloom-dev\' >&2; exit 1; fi',
          'exit 0',
          '',
        ].join('\n'),
      );
      chmodSync(stub, 0o755);
    });

    it('without --yes prints the plan and changes nothing', () => {
      const res = launch(['install'], [stubBin, emptyBin]);
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('claude mcp add --scope user cardloom -- npx -y cardloom-mcp');
      expect(readdirSync(home)).toEqual([]);
      expect(readFileSync(log, 'utf8')).not.toContain(' add ');
    });

    it('--yes registers and writes the instructions into the temp home only, never ~/.cardloom', () => {
      const res = launch(['install', '--yes'], [stubBin, emptyBin]);
      expect(res.code).toBe(0);
      expect(readFileSync(log, 'utf8')).toContain('mcp add --scope user cardloom -- npx -y cardloom-mcp');
      const file = join(home, '.claude', 'CLAUDE.md');
      const text = readFileSync(file, 'utf8');
      expect(text).toContain('<!-- cardloom:start -->');
      expect(text).toContain('## Knowledge Hub (MCP `cardloom`) — required');
      expect(existsSync(join(home, '.cardloom'))).toBe(false);
      expect(readdirSync(home)).toEqual(['.claude']);
    });
  });
});
