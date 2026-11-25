import * as nodeFs from 'node:fs';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENT_INSTRUCTIONS } from '../../src/config/agent-instructions.js';
import {
  detectEntry,
  MARKER_END,
  MARKER_START,
  MarkerError,
  parseInstallArgs,
  runInstall,
  upsertInstructionBlock,
} from '../../src/cli/install.js';
import type { AgentId, CommandRunner } from '../../src/cli/install.js';

const fixture = (name: string): string => readFileSync(resolve(__dirname, '..', 'fixtures', 'agent-cli', name), 'utf8');

type Result = { code: number; stdout: string; stderr: string };
type Handler = (cmd: string, args: string[]) => Result | undefined;

function fakeRunner(handler: Handler): CommandRunner & { calls: string[][]; cwds: (string | undefined)[] } {
  const calls: string[][] = [];
  const cwds: (string | undefined)[] = [];
  return {
    calls,
    cwds,
    async run(cmd, args, opts) {
      calls.push([cmd, ...args]);
      cwds.push(opts?.cwd);
      return handler(cmd, args) ?? { code: 1, stdout: '', stderr: `unexpected: ${cmd} ${args.join(' ')}` };
    },
  };
}

const ok = (stdout = '', stderr = ''): Result => ({ code: 0, stdout, stderr });
const fail = (stderr = 'boom', code = 1): Result => ({ code, stdout: '', stderr });

describe('upsertInstructionBlock', () => {
  const block = 'BLOCK LINE 1\nBLOCK LINE 2';
  const wrapped = `${MARKER_START}\n${block}\n${MARKER_END}\n`;

  it('wraps the block in the markers when the file is empty', () => {
    expect(upsertInstructionBlock('', block)).toBe(wrapped);
  });

  it('appends after existing text and keeps that text byte for byte', () => {
    const existing = '# Mine\r\n\r\nkeep   this  \n\n\tand this';
    const out = upsertInstructionBlock(existing, block);
    expect(out.startsWith(existing)).toBe(true);
    expect(out.endsWith(wrapped)).toBe(true);
  });

  it('applied twice yields one block', () => {
    const once = upsertInstructionBlock('# Mine\n', block);
    const twice = upsertInstructionBlock(once, block);
    expect(twice).toBe(once);
    expect(twice.split(MARKER_START).length - 1).toBe(1);
  });

  it('replaces only the text between the markers when the block changed', () => {
    const before = 'above\n\n';
    const after = '\nbelow, no trailing newline';
    const old = `${before}${MARKER_START}\nOLD\n${MARKER_END}${after}`;
    expect(upsertInstructionBlock(old, block)).toBe(`${before}${MARKER_START}\n${block}\n${MARKER_END}${after}`);
  });

  it.each([
    ['a start without an end', `x\n${MARKER_START}\nstuff\n`],
    ['an end without a start', `x\n${MARKER_END}\n`],
    ['an end before the start', `${MARKER_END}\n${MARKER_START}\n`],
    ['a repeated start', `${MARKER_START}\na\n${MARKER_END}\n${MARKER_START}\nb\n`],
    ['a repeated pair', `${MARKER_START}\na\n${MARKER_END}\n${MARKER_START}\nb\n${MARKER_END}\n`],
  ])('throws MarkerError on %s', (_label, existing) => {
    expect(() => upsertInstructionBlock(existing, block)).toThrow(MarkerError);
  });
});

describe('detectEntry', () => {
  it('claude: an entry running npx -y cardloom-mcp is ours', async () => {
    const r = fakeRunner(() => ok(fixture('claude-get-ours.txt')));
    expect(await detectEntry('claude', r)).toBe('ours');
    expect(r.calls).toEqual([['claude', 'mcp', 'get', 'cardloom']]);
  });

  it('claude: a cardloom entry with another command is foreign', async () => {
    expect(await detectEntry('claude', fakeRunner(() => ok(fixture('claude-get-foreign.txt'))))).toBe('foreign');
  });

  it('claude: not found (only cardloom-dev exists) is absent', async () => {
    const r = fakeRunner(() => fail(fixture('claude-get-absent.txt')));
    expect(await detectEntry('claude', r)).toBe('absent');
  });

  it('claude: any other failure throws instead of guessing', async () => {
    await expect(detectEntry('claude', fakeRunner(() => fail('network down')))).rejects.toThrow(/claude mcp get cardloom/);
  });

  it('claude: runs from the directory it is given', async () => {
    const r = fakeRunner(() => ok(fixture('claude-get-ours.txt')));
    await detectEntry('claude', r, { cwd: '/h' });
    expect(r.cwds).toEqual(['/h']);
  });

  it.each(['claude-get-local-ours.txt', 'claude-get-project-ours.txt'])(
    'claude: %s (cardloom-mcp registered for one project only) is absent at user scope',
    async (file) => {
      expect(await detectEntry('claude', fakeRunner(() => ok(fixture(file))))).toBe('absent');
    },
  );

  it('claude: a local-scope cardloom with another command is foreign', async () => {
    expect(await detectEntry('claude', fakeRunner(() => ok(fixture('claude-get-local-foreign.txt'))))).toBe('foreign');
  });

  it('claude: an entry without a Scope line is foreign, not ours', async () => {
    expect(await detectEntry('claude', fakeRunner(() => ok(fixture('claude-get-no-scope.txt'))))).toBe('foreign');
  });

  it('claude: an entry without a command line (http) is foreign', async () => {
    const http = 'cardloom:\n  Scope: User config (available in all your projects)\n  Type: http\n  URL: https://example.invalid/mcp\n';
    expect(await detectEntry('claude', fakeRunner(() => ok(http)))).toBe('foreign');
  });

  it.each([
    ['codex-list-ours.json', 'ours'],
    ['codex-list-foreign.json', 'foreign'],
    ['codex-list-absent.json', 'absent'],
  ])('codex: %s is %s', async (file, expected) => {
    const r = fakeRunner(() => ok(fixture(file)));
    expect(await detectEntry('codex', r)).toBe(expected);
    expect(r.calls).toEqual([['codex', 'mcp', 'list', '--json']]);
  });

  it('codex and gemini detection runs from the given directory', async () => {
    const c = fakeRunner(() => ok(fixture('codex-list-absent.json')));
    await detectEntry('codex', c, { cwd: '/h' });
    const g = fakeRunner(() => ok('', fixture('gemini-list-none.txt')));
    await detectEntry('gemini', g, { cwd: '/h' });
    expect([...c.cwds, ...g.cwds]).toEqual(['/h', '/h']);
  });

  it('codex: an http entry named cardloom is foreign', async () => {
    const list = JSON.stringify([{ name: 'cardloom', transport: { type: 'streamable_http', url: 'https://example.invalid' } }]);
    expect(await detectEntry('codex', fakeRunner(() => ok(list)))).toBe('foreign');
  });

  it('codex: unparsable output throws', async () => {
    await expect(detectEntry('codex', fakeRunner(() => ok('not json')))).rejects.toThrow(/codex mcp list/);
  });

  it.each([
    ['gemini-list-ours.txt', 'ours'],
    ['gemini-list-foreign.txt', 'foreign'],
    ['gemini-list-absent.txt', 'absent'],
    ['gemini-list-extension.txt', 'absent'],
    ['gemini-list-none.txt', 'absent'],
    // install checks from an untrusted temp folder: a warning comes first and every server is Disabled
    ['gemini-list-untrusted.txt', 'ours'],
  ])('gemini: %s is %s', async (file, expected) => {
    // The real CLI prints the list to stderr; stdout and stderr are read together.
    const r = fakeRunner(() => ok('', fixture(file)));
    expect(await detectEntry('gemini', r)).toBe(expected);
    expect(r.calls).toEqual([['gemini', 'mcp', 'list']]);
  });

  it('gemini: colour codes in the output do not hide the entry', async () => {
    const coloured = 'Configured MCP servers:\n\n\u001b[32m✓\u001b[39m cardloom: npx -y cardloom-mcp (stdio) - Connected\n';
    expect(await detectEntry('gemini', fakeRunner(() => ok(coloured)))).toBe('ours');
  });

  it('gemini: a list of only other servers under the header is absent', async () => {
    const out = 'Configured MCP servers:\n\n✓ example-search: https://search.example.invalid/mcp (http) - Connected\n';
    expect(await detectEntry('gemini', fakeRunner(() => ok('', out)))).toBe('absent');
  });

  it('gemini: the exact no-servers text is absent', async () => {
    expect(await detectEntry('gemini', fakeRunner(() => ok('', 'No MCP servers configured.\n')))).toBe('absent');
  });

  it.each([
    ['empty output', ''],
    ['an unrecognised header', 'MCP servers:\n\n✓ example-search: https://search.example.invalid/mcp (http) - Connected\n'],
    ['text that is not a list', 'something went sideways\n'],
    ['an unparsed line naming cardloom', 'Configured MCP servers:\n\n? cardloom (stdio) npx -y cardloom-mcp\n'],
    ['a new glyph-less line under the header', 'Configured MCP servers:\n\ncardloom: node /x/cardloom-fork/dist/index.js (stdio)\n'],
    ['an unparsed line before the header naming cardloom', 'note: cardloom: broken\nConfigured MCP servers:\n'],
  ])('gemini: %s is foreign and never read as absent', async (_label, out) => {
    expect(await detectEntry('gemini', fakeRunner(() => ok('', out)))).toBe('foreign');
  });

  it('gemini: an extension-provided cardloom is foreign', async () => {
    const out = 'Configured MCP servers:\n\n✓ cardloom (from some-extension): npx -y cardloom-mcp (stdio) - Connected\n';
    expect(await detectEntry('gemini', fakeRunner(() => ok(out)))).toBe('foreign');
  });

  it.each([
    ['npx', ['-y', 'cardloom-mcp']],
    ['npx', ['-y', 'cardloom-mcp@1.2.0']],
    ['/usr/local/bin/cardloom-mcp', []],
  ])('recognises %s %j as running cardloom-mcp', async (command, args) => {
    const list = JSON.stringify([{ name: 'cardloom', transport: { type: 'stdio', command, args } }]);
    expect(await detectEntry('codex', fakeRunner(() => ok(list)))).toBe('ours');
  });

  it.each([
    ['node', ['/home/me/cardloom-mcp/dist/index.js']],
    ['node', ['/home/me/cardloom-mcp/bin/cardloom-mcp.mjs']],
    ['npx', ['-y', 'cardloom-mcp-fork']],
    ['/opt/cardloom-mcp-old/run', []],
  ])('does not take %s %j for cardloom-mcp', async (command, args) => {
    const list = JSON.stringify([{ name: 'cardloom', transport: { type: 'stdio', command, args } }]);
    expect(await detectEntry('codex', fakeRunner(() => ok(list)))).toBe('foreign');
  });
});

// A tiny in-memory file system with the calls runInstall may use. `writes` lists the files a rename put in place
// (the final writes); `failOn` makes the write or the rename throw. `links` maps a symlink path to its target.
function fakeFs(initial: Record<string, string> = {}, opts: { failOn?: 'write' | 'rename'; links?: Record<string, string> } = {}) {
  const files = new Map(Object.entries(initial));
  const links = new Map(Object.entries(opts.links ?? {}));
  const writes: string[] = [];
  const dirs: string[] = [];
  const temps: string[] = [];
  const removed: string[] = [];
  const chmods: Array<[string, number]> = [];
  const real = (p: string): string => links.get(p) ?? p;
  const fs = {
    existsSync: (p: string) => files.has(real(p)),
    realpathSync: (p: string) => real(p),
    readFileSync: (p: string) => {
      const v = files.get(real(p));
      if (v === undefined) throw new Error(`ENOENT ${p}`);
      return v;
    },
    writeFileSync: (p: string, data: string) => {
      if (opts.failOn === 'write') {
        files.set(p, data.slice(0, 10)); // a partial temp file, as a full disk would leave
        throw new Error('ENOSPC');
      }
      files.set(real(p), data);
    },
    renameSync: (from: string, to: string) => {
      if (opts.failOn === 'rename') throw new Error('EXDEV');
      files.set(to, files.get(from) ?? '');
      files.delete(from);
      writes.push(to);
    },
    rmSync: (p: string) => {
      removed.push(p);
      files.delete(p);
    },
    statSync: (p: string) => {
      if (!files.has(real(p))) throw new Error(`ENOENT ${p}`);
      return { mode: 0o100644 };
    },
    chmodSync: (p: string, mode: number) => {
      chmods.push([p, mode]);
    },
    mkdtempSync: (prefix: string) => {
      const dir = `${prefix}${temps.length}`;
      temps.push(dir);
      return dir;
    },
    mkdirSync: (p: string) => {
      dirs.push(p);
      return undefined;
    },
  };
  return { fs: fs as unknown as Parameters<typeof runInstall>[3], files, writes, dirs, links, temps, removed, chmods };
}

const ABSENT_ALL: Handler = (cmd, args) => {
  if (cmd === 'claude' && args[1] === 'get') return fail(fixture('claude-get-absent.txt'));
  if (cmd === 'codex' && args[1] === 'list') return ok(fixture('codex-list-absent.json'));
  if (cmd === 'gemini' && args[1] === 'list') return ok('', fixture('gemini-list-none.txt'));
  if (args[1] === 'add') return ok();
  return undefined;
};

const countBlocks = (text: string | undefined): number => (text ?? '').split(MARKER_START).length - 1;

describe('runInstall', () => {
  it('codex only on PATH with CODEX_HOME: registers, then writes AGENTS.md under CODEX_HOME', async () => {
    const { fs, files } = fakeFs({ '/bin/codex': '' });
    const runner = fakeRunner(ABSENT_ALL);
    const res = await runInstall({ pathDirs: ['/bin'], home: '/h', codexHome: '/x' }, { yes: true }, runner, fs);
    expect(res.exitCode).toBe(0);
    expect(runner.calls).toEqual([
      ['codex', 'mcp', 'list', '--json'],
      ['codex', 'mcp', 'add', 'cardloom', '--', 'npx', '-y', 'cardloom-mcp'],
    ]);
    const text = files.get('/x/AGENTS.md');
    expect(text).toBe(`${MARKER_START}\n${AGENT_INSTRUCTIONS}\n${MARKER_END}\n`);
  });

  it('uses ~/.codex when CODEX_HOME is not set, and the standard files for claude and gemini', async () => {
    const { fs, files, dirs } = fakeFs({ '/bin/claude': '', '/bin/codex': '', '/bin/gemini': '' });
    const runner = fakeRunner(ABSENT_ALL);
    const res = await runInstall({ pathDirs: ['/bin'], home: '/h' }, { yes: true }, runner, fs);
    expect(res.exitCode).toBe(0);
    expect(runner.calls.filter((c) => c[2] === 'add' || c[3] === 'add')).toEqual([
      ['claude', 'mcp', 'add', '--scope', 'user', 'cardloom', '--', 'npx', '-y', 'cardloom-mcp'],
      ['codex', 'mcp', 'add', 'cardloom', '--', 'npx', '-y', 'cardloom-mcp'],
      ['gemini', 'mcp', 'add', '--scope', 'user', 'cardloom', 'npx', '-y', 'cardloom-mcp'],
    ]);
    expect([...files.keys()].filter((p) => p.endsWith('.md')).sort()).toEqual([
      '/h/.claude/CLAUDE.md',
      '/h/.codex/AGENTS.md',
      '/h/.gemini/GEMINI.md',
    ]);
    expect(dirs.sort()).toEqual(['/h/.claude', '/h/.codex', '/h/.gemini']);
  });

  it('register fails: no instructions, exit code 1; re-run with register succeeding writes them once', async () => {
    const { fs, files, writes } = fakeFs({ '/bin/codex': '' });
    const failing = fakeRunner((cmd, args) => (args[1] === 'add' ? fail('registry locked') : ABSENT_ALL(cmd, args)));
    const first = await runInstall({ pathDirs: ['/bin'], home: '/h' }, { yes: true }, failing, fs);
    expect(first.exitCode).toBe(1);
    expect(writes).toEqual([]);
    expect(first.lines.join('\n')).toContain('registry locked');

    const second = await runInstall({ pathDirs: ['/bin'], home: '/h' }, { yes: true }, fakeRunner(ABSENT_ALL), fs);
    expect(second.exitCode).toBe(0);
    expect(writes).toEqual(['/h/.codex/AGENTS.md']);
    expect(countBlocks(files.get('/h/.codex/AGENTS.md'))).toBe(1);
  });

  it('no agent CLI on PATH: message, exit code 1, nothing run or written', async () => {
    const { fs, writes, dirs } = fakeFs();
    const runner = fakeRunner(ABSENT_ALL);
    const res = await runInstall({ pathDirs: ['/bin', '/usr/bin'], home: '/h' }, { yes: true }, runner, fs);
    expect(res.exitCode).toBe(1);
    expect(res.lines).toEqual(['No supported agent CLI found (looked for claude, codex, gemini).']);
    expect(runner.calls).toEqual([]);
    expect(writes).toEqual([]);
    expect(dirs).toEqual([]);
  });

  it('without --yes: prints the plan, runs only the read-only check, writes nothing, exit code 0', async () => {
    const { fs, writes, dirs } = fakeFs({ '/bin/claude': '', '/bin/codex': '' });
    const runner = fakeRunner(ABSENT_ALL);
    const res = await runInstall({ pathDirs: ['/bin'], home: '/h' }, { yes: false }, runner, fs);
    expect(res.exitCode).toBe(0);
    expect(runner.calls.map((c) => c.slice(0, 3).join(' '))).toEqual(['claude mcp get', 'codex mcp list']);
    expect(writes).toEqual([]);
    expect(dirs).toEqual([]);
    const text = res.lines.join('\n');
    expect(text).toContain('claude mcp add --scope user cardloom -- npx -y cardloom-mcp');
    expect(text).toContain('codex mcp add cardloom -- npx -y cardloom-mcp');
    expect(text).toContain('/h/.claude/CLAUDE.md');
    expect(text).toContain('--yes');
  });

  it('opts.agents limits the agents considered', async () => {
    const { fs } = fakeFs({ '/bin/claude': '', '/bin/codex': '' });
    const runner = fakeRunner(ABSENT_ALL);
    await runInstall({ pathDirs: ['/bin'], home: '/h' }, { yes: true, agents: ['codex'] }, runner, fs);
    expect(runner.calls.every((c) => c[0] === 'codex')).toBe(true);
    const none = await runInstall({ pathDirs: ['/bin'], home: '/h' }, { yes: true, agents: ['gemini'] }, runner, fs);
    expect(none.lines).toEqual(['No supported agent CLI found (looked for gemini).']);
  });

  it('runs every detection command from one empty temp directory that is removed afterwards', async () => {
    const { fs, temps, removed } = fakeFs({ '/bin/claude': '', '/bin/codex': '', '/bin/gemini': '' });
    const runner = fakeRunner(ABSENT_ALL);
    await runInstall({ pathDirs: ['/bin'], home: '/h' }, { yes: false }, runner, fs);
    expect(runner.calls).toHaveLength(3);
    expect(temps).toHaveLength(1);
    expect(temps[0]?.startsWith(path.join(os.tmpdir(), 'cardloom-install-'))).toBe(true);
    expect(runner.cwds).toEqual([temps[0], temps[0], temps[0]]);
    expect(runner.cwds).not.toContain('/h');
    expect(removed).toContain(temps[0]);
  });

  it('removes the temp directory when an agent check fails too', async () => {
    const { fs, temps, removed } = fakeFs({ '/bin/claude': '' });
    const runner = fakeRunner(() => fail('claude is on fire'));
    const res = await runInstall({ pathDirs: ['/bin'], home: '/h' }, { yes: true }, runner, fs);
    expect(res.exitCode).toBe(1);
    expect(removed).toContain(temps[0]);
  });

  it('with the real file system the detection directory exists and is empty during the run, and is gone after', async () => {
    const root = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'cardloom-install-test-'));
    try {
      const bin = path.join(root, 'bin');
      nodeFs.mkdirSync(bin);
      nodeFs.writeFileSync(path.join(bin, 'claude'), '');
      const seen: { cwd?: string; existed?: boolean; entries?: string[] } = {};
      const runner: CommandRunner = {
        async run(_cmd, args, opts) {
          if (args[1] === 'get') {
            seen.cwd = opts?.cwd;
            seen.existed = opts?.cwd !== undefined && nodeFs.existsSync(opts.cwd);
            seen.entries = opts?.cwd === undefined ? undefined : nodeFs.readdirSync(opts.cwd);
            return fail(fixture('claude-get-absent.txt'));
          }
          return ok();
        },
      };
      const res = await runInstall({ pathDirs: [bin], home: path.join(root, 'home') }, { yes: true }, runner, nodeFs);
      expect(res.exitCode).toBe(0);
      expect(seen.existed).toBe(true);
      expect(seen.entries).toEqual([]);
      expect(seen.cwd?.startsWith(path.join(os.tmpdir(), 'cardloom-install-'))).toBe(true);
      expect(nodeFs.existsSync(seen.cwd as string)).toBe(false);
    } finally {
      nodeFs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('a second run after a successful first one sees the user-scope entry: ours, no register, block refreshed', async () => {
    const { fs, files } = fakeFs({ '/bin/claude': '' });
    let registered = false;
    const runner = fakeRunner((cmd, args) => {
      if (args[1] === 'get') return registered ? ok(fixture('claude-get-ours.txt')) : fail(fixture('claude-get-absent.txt'));
      if (args[1] === 'add') {
        registered = true;
        return ok();
      }
      return undefined;
    });
    const env = { pathDirs: ['/bin'], home: '/h' };
    const first = await runInstall(env, { yes: true }, runner, fs);
    expect(first.exitCode).toBe(0);
    expect(runner.calls.filter((c) => c[2] === 'add')).toHaveLength(1);

    files.set('/h/.claude/CLAUDE.md', `# Mine\n${MARKER_START}\nstale\n${MARKER_END}\n`);
    const second = await runInstall(env, { yes: true }, runner, fs);
    expect(second.exitCode).toBe(0);
    expect(runner.calls.filter((c) => c[2] === 'add')).toHaveLength(1);
    const text = second.lines.join('\n');
    expect(text).toContain('server already registered');
    expect(text).toContain('instructions updated');
    expect(files.get('/h/.claude/CLAUDE.md')).toBe(`# Mine\n${MARKER_START}\n${AGENT_INSTRUCTIONS}\n${MARKER_END}\n`);
  });

  it('a project-scope cardloom-mcp entry does not count as registered: the user-scope entry is added', async () => {
    const { fs, files } = fakeFs({ '/bin/claude': '' });
    const runner = fakeRunner((cmd, args) => (args[1] === 'get' ? ok(fixture('claude-get-local-ours.txt')) : ok()));
    const res = await runInstall({ pathDirs: ['/bin'], home: '/h' }, { yes: true }, runner, fs);
    expect(res.exitCode).toBe(0);
    expect(runner.calls).toContainEqual(['claude', 'mcp', 'add', '--scope', 'user', 'cardloom', '--', 'npx', '-y', 'cardloom-mcp']);
    expect(files.has('/h/.claude/CLAUDE.md')).toBe(true);
  });

  it('a cardloom of unknown scope is left unchanged with the scope note and no instructions', async () => {
    const { fs, files } = fakeFs({ '/bin/claude': '' });
    const runner = fakeRunner((cmd, args) => (args[1] === 'get' ? ok(fixture('claude-get-no-scope.txt')) : ok()));
    const res = await runInstall({ pathDirs: ['/bin'], home: '/h' }, { yes: true }, runner, fs);
    expect(res.exitCode).toBe(0);
    expect(res.lines.join('\n')).toContain('cardloom found outside user scope; left unchanged');
    expect(runner.calls).toHaveLength(1);
    expect(files.has('/h/.claude/CLAUDE.md')).toBe(false);
  });

  describe('instruction file writes are atomic', () => {
    const original = '# Mine\nprecious text\n';
    const codexOurs: Handler = (cmd, args) => (args[1] === 'list' ? ok(fixture('codex-list-ours.json')) : undefined);

    it.each(['write', 'rename'] as const)('a failing %s keeps the original and removes the temp file', async (failOn) => {
      const { fs, files, writes } = fakeFs({ '/bin/codex': '', '/h/.codex/AGENTS.md': original }, { failOn });
      const res = await runInstall({ pathDirs: ['/bin'], home: '/h' }, { yes: true }, fakeRunner(codexOurs), fs);
      expect(res.exitCode).toBe(1);
      expect(files.get('/h/.codex/AGENTS.md')).toBe(original);
      expect(files.has('/h/.codex/AGENTS.md.cardloom-tmp')).toBe(false);
      expect(writes).toEqual([]);
      expect(res.lines.join('\n')).toMatch(/ENOSPC|EXDEV/);
    });

    it('a failing write to a new file leaves no file and no temp file', async () => {
      const { fs, files } = fakeFs({ '/bin/codex': '' }, { failOn: 'write' });
      const res = await runInstall({ pathDirs: ['/bin'], home: '/h' }, { yes: true }, fakeRunner(codexOurs), fs);
      expect(res.exitCode).toBe(1);
      expect([...files.keys()]).toEqual(['/bin/codex']);
    });

    it('writes through the temp file and renames it into place', async () => {
      const { fs, files, writes } = fakeFs({ '/bin/codex': '', '/h/.codex/AGENTS.md': original });
      await runInstall({ pathDirs: ['/bin'], home: '/h' }, { yes: true }, fakeRunner(codexOurs), fs);
      expect(writes).toEqual(['/h/.codex/AGENTS.md']);
      expect(files.has('/h/.codex/AGENTS.md.cardloom-tmp')).toBe(false);
      expect(files.get('/h/.codex/AGENTS.md')?.startsWith(original)).toBe(true);
    });

    it('a symlinked instructions file keeps being a symlink: the new content lands at the real path', async () => {
      const { fs, files, writes, links } = fakeFs(
        { '/bin/codex': '', '/dotfiles/AGENTS.md': original },
        { links: { '/h/.codex/AGENTS.md': '/dotfiles/AGENTS.md' } },
      );
      const res = await runInstall({ pathDirs: ['/bin'], home: '/h' }, { yes: true }, fakeRunner(codexOurs), fs);
      expect(res.exitCode).toBe(0);
      expect(writes).toEqual(['/dotfiles/AGENTS.md']);
      expect(links.get('/h/.codex/AGENTS.md')).toBe('/dotfiles/AGENTS.md');
      expect(countBlocks(files.get('/dotfiles/AGENTS.md'))).toBe(1);
      expect(files.get('/dotfiles/AGENTS.md')?.startsWith(original)).toBe(true);
      expect(files.has('/dotfiles/AGENTS.md.cardloom-tmp')).toBe(false);
    });
  });

  // Review Focus 3
  it('re-run after a failure in the middle finishes the remaining agents and never duplicates the block', async () => {
    const { fs, files } = fakeFs({ '/bin/claude': '', '/bin/codex': '', '/bin/gemini': '' });
    const registered = new Set<AgentId>();
    let codexBroken = true;
    const runner = fakeRunner((cmd, args) => {
      const agent = cmd as AgentId;
      if (args.includes('add')) {
        if (agent === 'codex' && codexBroken) return fail('codex: cannot write config.toml');
        registered.add(agent);
        return ok();
      }
      if (agent === 'claude') {
        return registered.has('claude') ? ok(fixture('claude-get-ours.txt')) : fail(fixture('claude-get-absent.txt'));
      }
      if (agent === 'codex') {
        return ok(fixture(registered.has('codex') ? 'codex-list-ours.json' : 'codex-list-absent.json'));
      }
      return ok('', fixture(registered.has('gemini') ? 'gemini-list-ours.txt' : 'gemini-list-none.txt'));
    });
    const env = { pathDirs: ['/bin'], home: '/h' };

    const first = await runInstall(env, { yes: true }, runner, fs);
    expect(first.exitCode).toBe(1);
    expect(first.lines.join('\n')).toMatch(/codex/);
    expect(files.has('/h/.claude/CLAUDE.md')).toBe(true);
    expect(files.has('/h/.codex/AGENTS.md')).toBe(false);
    expect(files.has('/h/.gemini/GEMINI.md')).toBe(true);

    codexBroken = false;
    const second = await runInstall(env, { yes: true }, runner, fs);
    expect(second.exitCode).toBe(0);
    for (const p of ['/h/.claude/CLAUDE.md', '/h/.codex/AGENTS.md', '/h/.gemini/GEMINI.md']) {
      expect(countBlocks(files.get(p))).toBe(1);
    }
    // claude and gemini were already ours on the re-run: no second register call for them
    expect(runner.calls.filter((c) => c[0] === 'claude' && c.includes('add'))).toHaveLength(1);
    expect(runner.calls.filter((c) => c[0] === 'gemini' && c.includes('add'))).toHaveLength(1);

    const third = await runInstall(env, { yes: true }, runner, fs);
    expect(third.exitCode).toBe(0);
    expect(countBlocks(files.get('/h/.codex/AGENTS.md'))).toBe(1);
  });

  it('one agent failing does not stop the others, and writing fails soft', async () => {
    const { fs, files } = fakeFs({ '/bin/claude': '', '/bin/codex': '' });
    const runner = fakeRunner((cmd, args) => {
      if (cmd === 'claude' && args[1] === 'get') return fail('claude is on fire');
      return ABSENT_ALL(cmd, args);
    });
    const res = await runInstall({ pathDirs: ['/bin'], home: '/h' }, { yes: true }, runner, fs);
    expect(res.exitCode).toBe(1);
    expect(files.has('/h/.codex/AGENTS.md')).toBe(true);
    expect(files.has('/h/.claude/CLAUDE.md')).toBe(false);
    expect(runner.calls.some((c) => c[0] === 'claude' && c.includes('add'))).toBe(false);
  });

  // Review Focus 4
  it('an entry named cardloom-dev is not treated as installed and is left untouched', async () => {
    const { fs, files } = fakeFs({ '/bin/codex': '' });
    const runner = fakeRunner(ABSENT_ALL); // the list fixture contains cardloom-dev
    expect(fixture('codex-list-absent.json')).toContain('cardloom-dev');
    const res = await runInstall({ pathDirs: ['/bin'], home: '/h' }, { yes: true }, runner, fs);
    expect(res.exitCode).toBe(0);
    expect(runner.calls).toContainEqual(['codex', 'mcp', 'add', 'cardloom', '--', 'npx', '-y', 'cardloom-mcp']);
    expect(runner.calls.some((c) => c.some((a) => a === 'remove' || a === 'enable' || a === 'disable'))).toBe(false);
    expect(runner.calls.some((c) => c.includes('cardloom-dev'))).toBe(false);
    expect(files.has('/h/.codex/AGENTS.md')).toBe(true);
  });

  it.each([
    ['claude', (): Handler => (cmd, args) => (args[1] === 'get' ? ok(fixture('claude-get-foreign.txt')) : undefined)],
    ['codex', (): Handler => (cmd, args) => (args[1] === 'list' ? ok(fixture('codex-list-foreign.json')) : undefined)],
    ['gemini', (): Handler => (cmd, args) => (args[1] === 'list' ? ok('', fixture('gemini-list-foreign.txt')) : undefined)],
  ] as const)(
    'a cardloom entry with another command (%s) is left unchanged, nothing registered, no instructions',
    async (agent, makeHandler) => {
      const { fs, files, writes, dirs } = fakeFs({ [`/bin/${agent}`]: '' });
      const runner = fakeRunner(makeHandler());
      const res = await runInstall({ pathDirs: ['/bin'], home: '/h' }, { yes: true }, runner, fs);
      expect(runner.calls).toHaveLength(1); // only the read-only check
      expect(writes).toEqual([]);
      expect(dirs).toEqual([]);
      expect([...files.keys()]).toEqual([`/bin/${agent}`]);
      expect(res.lines.join('\n')).toContain('existing cardloom entry uses another command; left unchanged');
      expect(res.exitCode).toBe(0);
    },
  );

  it('an unreadable gemini server list is left unchanged: no register, no instructions, exit 0', async () => {
    const { fs, files } = fakeFs({ '/bin/gemini': '' });
    const runner = fakeRunner((cmd, args) => (args[1] === 'list' ? ok('', '') : ok()));
    const res = await runInstall({ pathDirs: ['/bin'], home: '/h' }, { yes: true }, runner, fs);
    expect(res.exitCode).toBe(0);
    expect(runner.calls.some((c) => c.includes('add'))).toBe(false);
    expect(files.has('/h/.gemini/GEMINI.md')).toBe(false);
    expect(res.lines.join('\n')).toContain("could not read gemini's server list; left unchanged");
  });

  it('an entry already ours is not registered again, but its instructions are written', async () => {
    const { fs, files } = fakeFs({ '/bin/codex': '' });
    const runner = fakeRunner((cmd, args) => (args[1] === 'list' ? ok(fixture('codex-list-ours.json')) : undefined));
    const res = await runInstall({ pathDirs: ['/bin'], home: '/h' }, { yes: true }, runner, fs);
    expect(res.exitCode).toBe(0);
    expect(runner.calls).toEqual([['codex', 'mcp', 'list', '--json']]);
    expect(countBlocks(files.get('/h/.codex/AGENTS.md'))).toBe(1);
  });

  it('keeps existing instruction text and replaces an older block in place', async () => {
    const old = `# Mine\n\n${MARKER_START}\nstale text\n${MARKER_END}\n\n# After\n`;
    const { fs, files } = fakeFs({ '/bin/codex': '', '/h/.codex/AGENTS.md': old });
    const runner = fakeRunner((cmd, args) => (args[1] === 'list' ? ok(fixture('codex-list-ours.json')) : undefined));
    await runInstall({ pathDirs: ['/bin'], home: '/h' }, { yes: true }, runner, fs);
    expect(files.get('/h/.codex/AGENTS.md')).toBe(
      `# Mine\n\n${MARKER_START}\n${AGENT_INSTRUCTIONS}\n${MARKER_END}\n\n# After\n`,
    );
  });

  it('does not rewrite a file whose block is already current', async () => {
    const current = `${MARKER_START}\n${AGENT_INSTRUCTIONS}\n${MARKER_END}\n`;
    const { fs, writes } = fakeFs({ '/bin/codex': '', '/h/.codex/AGENTS.md': current });
    const runner = fakeRunner((cmd, args) => (args[1] === 'list' ? ok(fixture('codex-list-ours.json')) : undefined));
    const res = await runInstall({ pathDirs: ['/bin'], home: '/h' }, { yes: true }, runner, fs);
    expect(res.exitCode).toBe(0);
    expect(writes).toEqual([]);
  });

  describe.skipIf(process.platform === 'win32')('file mode with the real file system', () => {
    const codexOurs: CommandRunner = { run: async () => ok(fixture('codex-list-ours.json')) };

    async function installInto(root: string): Promise<void> {
      const bin = path.join(root, 'bin');
      nodeFs.mkdirSync(bin, { recursive: true });
      nodeFs.writeFileSync(path.join(bin, 'codex'), '');
      const res = await runInstall({ pathDirs: [bin], home: path.join(root, 'home') }, { yes: true }, codexOurs, nodeFs);
      expect(res.exitCode).toBe(0);
    }

    it('keeps the mode of an existing 0600 file', async () => {
      const root = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'cardloom-mode-'));
      try {
        const file = path.join(root, 'home', '.codex', 'AGENTS.md');
        nodeFs.mkdirSync(path.dirname(file), { recursive: true });
        nodeFs.writeFileSync(file, '# Mine\n', { mode: 0o600 });
        nodeFs.chmodSync(file, 0o600);
        await installInto(root);
        expect(nodeFs.readFileSync(file, 'utf8')).toContain(MARKER_START);
        expect(nodeFs.statSync(file).mode & 0o777).toBe(0o600);
        expect(nodeFs.readdirSync(path.dirname(file))).toEqual(['AGENTS.md']);
      } finally {
        nodeFs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('a new file gets the default mode', async () => {
      const root = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'cardloom-mode-'));
      try {
        await installInto(root);
        const dir = path.join(root, 'home', '.codex');
        const control = path.join(dir, 'control');
        nodeFs.writeFileSync(control, '');
        expect(nodeFs.statSync(path.join(dir, 'AGENTS.md')).mode & 0o777).toBe(nodeFs.statSync(control).mode & 0o777);
      } finally {
        nodeFs.rmSync(root, { recursive: true, force: true });
      }
    });
  });

  it('applies the existing file mode to the temp file before the rename, and nothing for a new file', async () => {
    const { fs, chmods } = fakeFs({ '/bin/codex': '', '/h/.codex/AGENTS.md': '# Mine\n' });
    const runner = fakeRunner((cmd, args) => (args[1] === 'list' ? ok(fixture('codex-list-ours.json')) : undefined));
    await runInstall({ pathDirs: ['/bin'], home: '/h' }, { yes: true }, runner, fs);
    expect(chmods).toEqual([['/h/.codex/AGENTS.md.cardloom-tmp', 0o644]]);

    const fresh = fakeFs({ '/bin/codex': '' });
    await runInstall({ pathDirs: ['/bin'], home: '/h' }, { yes: true }, fakeRunner((cmd, args) => (args[1] === 'list' ? ok(fixture('codex-list-ours.json')) : undefined)), fresh.fs);
    expect(fresh.chmods).toEqual([]);
  });

  it('a broken marker pair fails that agent and leaves the file untouched', async () => {
    const broken = `# Mine\n${MARKER_START}\nno end marker\n`;
    const { fs, files, writes } = fakeFs({ '/bin/codex': '', '/h/.codex/AGENTS.md': broken });
    const runner = fakeRunner((cmd, args) => (args[1] === 'list' ? ok(fixture('codex-list-ours.json')) : undefined));
    const res = await runInstall({ pathDirs: ['/bin'], home: '/h' }, { yes: true }, runner, fs);
    expect(res.exitCode).toBe(1);
    expect(writes).toEqual([]);
    expect(files.get('/h/.codex/AGENTS.md')).toBe(broken);
    expect(res.lines.join('\n')).toContain('/h/.codex/AGENTS.md');
  });

  it('leaves a file that already has an unmarked Knowledge Hub section alone', async () => {
    const hand = `# Mine\n\n${AGENT_INSTRUCTIONS}\n`;
    const { fs, files, writes } = fakeFs({ '/bin/codex': '', '/h/.codex/AGENTS.md': hand });
    const runner = fakeRunner((cmd, args) => (args[1] === 'list' ? ok(fixture('codex-list-ours.json')) : undefined));
    const res = await runInstall({ pathDirs: ['/bin'], home: '/h' }, { yes: true }, runner, fs);
    expect(res.exitCode).toBe(0);
    expect(writes).toEqual([]);
    expect(files.get('/h/.codex/AGENTS.md')).toBe(hand);
    expect(res.lines.join('\n')).toContain('already has a Knowledge Hub section');
    expect(res.lines.join('\n')).toContain('wrap it in <!-- cardloom:start --> / <!-- cardloom:end --> or delete it to let install keep it current');
  });
});

describe('parseInstallArgs', () => {
  it('defaults to a plan', () => {
    expect(parseInstallArgs([])).toEqual({ yes: false, agents: undefined });
  });
  it('reads --yes and repeated --agent', () => {
    expect(parseInstallArgs(['--yes', '--agent', 'claude', '--agent', 'gemini'])).toEqual({
      yes: true,
      agents: ['claude', 'gemini'],
    });
  });
  it.each([['--help'], ['-h'], ['--yes', '--help']])('%j asks for the usage', (...argv) => {
    expect(parseInstallArgs(argv)?.help).toBe(true);
  });
  it.each([['--agent'], ['--agent', 'cursor'], ['--force'], ['yes']])('rejects %j', (...argv) => {
    expect(parseInstallArgs(argv)).toBeNull();
  });
});
