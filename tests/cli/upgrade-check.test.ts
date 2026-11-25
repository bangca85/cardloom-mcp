import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import {
  formatUpgradeCheck,
  loadKnowledgeMap,
  parseUpgradeCheckArgs,
  runUpgradeCheck,
  runUpgradeCheckCommand,
  UPGRADE_CHECK_USAGE,
} from '../../src/cli/upgrade-check.js';
import type { UpgradeCheck } from '../../src/cli/upgrade-check.js';

interface Fixture {
  id: string;
  range: string;
  stack?: string[];
  status?: 'draft' | 'verified' | 'deprecated';
  sensitivity?: 'normal' | 'restricted';
  title?: string;
}

function insertCard(db: Database.Database, f: Fixture): void {
  const status = f.status ?? 'verified';
  db.prepare(
    `INSERT INTO cards (
      id, type, status, title, domain, stack, applies_to, task_type, error_signature,
      scope, version_range, sensitivity, supersedes, conflicts_with, source_commit, provenance,
      verified_by, verification_method, last_verified, deprecation_reason, deprecated_at, deprecated_by,
      body, created_at, updated_at, file_mtime, project
    ) VALUES (
      @id, 'pattern', @status, @title, NULL, @stack, '["api"]', NULL, NULL,
      'stack', @range, @sensitivity, NULL, '[]', 'abc123', 'agent-observation',
      @verified_by, 'manual-review', @last_verified, NULL, NULL, NULL,
      'body', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', NULL
    )`,
  ).run({
    id: f.id,
    status,
    title: f.title ?? `Title ${f.id}`,
    stack: JSON.stringify(f.stack ?? ['next']),
    range: f.range,
    sensitivity: f.sensitivity ?? 'normal',
    verified_by: status === 'draft' ? null : 'bradley',
    last_verified: status === 'draft' ? null : '2026-01-01T00:00:00Z',
  });
}

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  initializeSchema(db);
});
afterEach(() => {
  db.close();
});

const MAP = { stack: ['next@14.2.0', 'node@20.1.0', 'postgres'] };

describe('runUpgradeCheck', () => {
  it('splits cards into stop / start / still applying and leaves out wildcard cards', () => {
    insertCard(db, { id: 'c14', range: '>=14 <15' });
    insertCard(db, { id: 'c15', range: '>=15' });
    insertCard(db, { id: 'c13', range: '>=13' });
    insertCard(db, { id: 'cstar', range: '*' });
    const [check] = runUpgradeCheck(db, MAP, ['next@15.0.0']);
    expect(check).toEqual({
      tech: 'next',
      from: '14.2.0',
      to: '15.0.0',
      stopApplying: ['c14'],
      startApplying: ['c15'],
      stillApplying: ['c13'],
    });
  });

  it('ignores cards of other techs and cards whose stack lacks the tech', () => {
    insertCard(db, { id: 'cnode', range: '>=14 <15', stack: ['node'] });
    insertCard(db, { id: 'cnext', range: '>=14 <15', stack: ['node', 'Next'] });
    const [check] = runUpgradeCheck(db, MAP, ['next@15.0.0']);
    expect(check.stopApplying).toEqual(['cnext']);
  });

  it('lists only verified, non-restricted cards', () => {
    insertCard(db, { id: 'ok', range: '>=14 <15' });
    insertCard(db, { id: 'a-draft', range: '>=14 <15', status: 'draft' });
    insertCard(db, { id: 'a-old', range: '>=14 <15', status: 'deprecated' });
    insertCard(db, { id: 'a-secret', range: '>=14 <15', sensitivity: 'restricted' });
    const [check] = runUpgradeCheck(db, MAP, ['next@15.0.0']);
    expect(check.stopApplying).toEqual(['ok']);
  });

  it('caps each list at 20 and sorts by id', () => {
    for (let i = 24; i >= 0; i--) {
      insertCard(db, { id: `stop-${String(i).padStart(2, '0')}`, range: '>=14 <15' });
    }
    const [check] = runUpgradeCheck(db, MAP, ['next@15.0.0']);
    expect(check.stopApplying).toHaveLength(20);
    expect(check.stopApplying[0]).toBe('stop-00');
    expect(check.stopApplying[19]).toBe('stop-19');
  });

  it('handles several targets, in the order given', () => {
    insertCard(db, { id: 'cn', range: '>=14 <15' });
    insertCard(db, { id: 'cnode', range: '^20', stack: ['node'] });
    const checks = runUpgradeCheck(db, MAP, ['node@22.0.0', 'next@15.0.0']);
    expect(checks.map((c) => c.tech)).toEqual(['node', 'next']);
    expect(checks[0].stopApplying).toEqual(['cnode']);
    expect(checks[1].stopApplying).toEqual(['cn']);
  });

  it('names a tech that is not in the map stack', () => {
    expect(() => runUpgradeCheck(db, MAP, ['rails@8.0.0'])).toThrow(/rails/);
    expect(() => runUpgradeCheck(db, MAP, ['rails@8.0.0'])).toThrow(/\.knowledge-map\.yaml/);
  });

  it('refuses a tech the map lists without a version', () => {
    expect(() => runUpgradeCheck(db, MAP, ['postgres@17'])).toThrow(/postgres.*no version/);
  });

  it.each([['canary'], ['latest'], ['next'], ['rc']])('refuses --to next@%s, naming the value and the argument', (v) => {
    insertCard(db, { id: 'c14', range: '>=14 <15' });
    expect(() => runUpgradeCheck(db, MAP, [`next@${v}`])).toThrow(new RegExp(`"${v}" \\(--to next@${v}\\) is not a semver`));
  });

  it('refuses a map entry with a non-semver version, naming the map', () => {
    expect(() => runUpgradeCheck(db, { stack: ['next@latest'] }, ['next@15.0.0'])).toThrow(/"latest" \(next in \.knowledge-map\.yaml\) is not a semver/);
  });

  it.each([['15'], ['15.0.0'], ['15.0.0-rc.1'], ['15.x']])('accepts the version or range %s', (v) => {
    expect(() => runUpgradeCheck(db, MAP, [`next@${v}`])).not.toThrow();
  });

  it('leaves out cards whose version_range is empty or invalid (read as * by normalizeRange)', () => {
    insertCard(db, { id: 'good', range: '>=14 <15' });
    insertCard(db, { id: 'empty', range: '' });
    insertCard(db, { id: 'junk', range: 'not a range' });
    insertCard(db, { id: 'anyx', range: 'x' });
    const [check] = runUpgradeCheck(db, MAP, ['next@15.0.0']);
    expect(check).toMatchObject({ stopApplying: ['good'], startApplying: [], stillApplying: [] });
  });

  it('normalises case and spaces in the tech name', () => {
    insertCard(db, { id: 'cnj', range: '>=14 <15', stack: ['Next JS'] });
    const [check] = runUpgradeCheck(db, { stack: ['Next JS@14.2.0'] }, ['next-js@15.0.0']);
    expect(check.tech).toBe('next-js');
    expect(check.stopApplying).toEqual(['cnj']);
  });
});

describe('parseUpgradeCheckArgs', () => {
  it('collects every --to and the --json flag', () => {
    expect(parseUpgradeCheckArgs(['--to', 'next@15', '--to', 'node@22', '--json'])).toEqual({
      targets: ['next@15', 'node@22'],
      json: true,
    });
  });

  it('flags help', () => {
    expect(parseUpgradeCheckArgs(['--help'])?.help).toBe(true);
    expect(parseUpgradeCheckArgs(['-h'])?.help).toBe(true);
  });

  it.each([[[]], [['--to']], [['--to', 'next']], [['--to', '@15']], [['--to', 'next@']], [['--bogus']], [['--to', 'next@15', 'x']]])(
    'rejects %j',
    (argv) => {
      expect(parseUpgradeCheckArgs(argv as string[])).toBeNull();
    },
  );

  it('has a usage line naming the flags', () => {
    expect(UPGRADE_CHECK_USAGE).toContain('Usage: upgrade-check --to <tech>@<version>');
  });
});

describe('formatUpgradeCheck', () => {
  const titles = new Map([
    ['c14', 'Old routing rule'],
    ['c15', 'New caching default'],
  ]);

  it('prints a section per tech with counts and id · title lines', () => {
    const check: UpgradeCheck = {
      tech: 'next',
      from: '14.2.0',
      to: '15.0.0',
      stopApplying: ['c14'],
      startApplying: ['c15'],
      stillApplying: [],
    };
    const out = formatUpgradeCheck([check], titles);
    expect(out).toBe(
      [
        'next 14.2.0 -> 15.0.0',
        '',
        '  Stop applying (1)',
        '    c14 · Old routing rule',
        '',
        '  Start applying (1)',
        '    c15 · New caching default',
        '',
        '  Apply to both (0)',
      ].join('\n'),
    );
  });

  it('says nothing changes when the stop and start lists are empty', () => {
    const check: UpgradeCheck = { tech: 'node', from: '20.1.0', to: '22.0.0', stopApplying: [], startApplying: [], stillApplying: [] };
    expect(formatUpgradeCheck([check], titles)).toBe('node 20.1.0 -> 22.0.0\n\n  Nothing changes for node');
  });

  it('marks a list that reached the cap', () => {
    const ids = Array.from({ length: 20 }, (_, i) => `x-${String(i).padStart(2, '0')}`);
    const check: UpgradeCheck = { tech: 'next', from: '14.2.0', to: '15.0.0', stopApplying: ids, startApplying: [], stillApplying: [] };
    expect(formatUpgradeCheck([check], new Map())).toContain('Stop applying (20, capped at 20)');
  });
});

describe('loadKnowledgeMap and runUpgradeCheckCommand', () => {
  let tmp: string;
  let cwd: string;
  let store: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cardloom-mcp-upgrade-'));
    cwd = path.join(tmp, 'repo');
    store = path.join(tmp, 'store');
    fs.mkdirSync(cwd);
    fs.mkdirSync(path.join(store, 'cards'), { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function writeCard(name: string, title: string, range: string): void {
    fs.writeFileSync(
      path.join(store, 'cards', `${name}.md`),
      `---
type: pattern
scope: stack
applies_to: [api]
stack: [next]
version_range: "${range}"
sensitivity: normal
source_commit: abc123
provenance: agent-observation
title: ${title}
status: verified
verified_by: reviewer
verification_method: manual-review
last_verified: "2026-01-01T00:00:00Z"
---
Body of ${title}.
`,
    );
  }

  it('reports a missing map with the exact message', () => {
    expect(() => loadKnowledgeMap(cwd)).toThrow(`no .knowledge-map.yaml in ${cwd}`);
  });

  it('reports an unparseable map', () => {
    fs.writeFileSync(path.join(cwd, '.knowledge-map.yaml'), 'stack: [unclosed\n');
    expect(() => loadKnowledgeMap(cwd)).toThrow(/could not parse .*\.knowledge-map\.yaml/);
  });

  it('reports a map without a stack list', () => {
    fs.writeFileSync(path.join(cwd, '.knowledge-map.yaml'), 'project: acme/x\n');
    expect(() => loadKnowledgeMap(cwd)).toThrow(/stack/);
  });

  it('reads the stack from the map', () => {
    fs.writeFileSync(path.join(cwd, '.knowledge-map.yaml'), 'stack:\n  - next@14.2.0\n  - node\n');
    expect(loadKnowledgeMap(cwd)).toEqual({ stack: ['next@14.2.0', 'node'] });
  });

  it('runs end to end against a store: text and JSON, exit 0', async () => {
    fs.writeFileSync(path.join(cwd, '.knowledge-map.yaml'), 'stack:\n  - next@14.2.0\n');
    writeCard('pattern-old', 'Old routing rule', '>=14 <15');
    writeCard('pattern-new', 'New caching default', '>=15');
    const text = await runUpgradeCheckCommand(store, cwd, { targets: ['next@15.0.0'], json: false });
    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain('Stop applying (1)\n    pattern-old · Old routing rule');
    expect(text.stdout).toContain('Start applying (1)\n    pattern-new · New caching default');
    const json = await runUpgradeCheckCommand(store, cwd, { targets: ['next@15.0.0'], json: true });
    expect(JSON.parse(json.stdout)).toEqual([
      { tech: 'next', from: '14.2.0', to: '15.0.0', stopApplying: ['pattern-old'], startApplying: ['pattern-new'], stillApplying: [] },
    ]);
  });

  it('exits 1 with the message when the map is missing, the tech is unknown, and does not touch the store', async () => {
    const missing = await runUpgradeCheckCommand(store, cwd, { targets: ['next@15.0.0'], json: false });
    expect(missing).toEqual({ stdout: '', stderr: `no .knowledge-map.yaml in ${cwd}`, exitCode: 1 });

    fs.writeFileSync(path.join(cwd, '.knowledge-map.yaml'), 'stack:\n  - next@14.2.0\n');
    const unknown = await runUpgradeCheckCommand(store, cwd, { targets: ['rails@8.0.0'], json: false });
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toContain('rails');
    expect(fs.readdirSync(store)).toEqual(['cards']);
  });

  it('exits 1 with the message on stderr for a non-semver --to or map version', async () => {
    fs.writeFileSync(path.join(cwd, '.knowledge-map.yaml'), 'stack:\n  - next@14.2.0\n');
    for (const v of ['canary', 'latest']) {
      const res = await runUpgradeCheckCommand(store, cwd, { targets: [`next@${v}`], json: false });
      expect(res.exitCode).toBe(1);
      expect(res.stdout).toBe('');
      expect(res.stderr).toContain(`"${v}" (--to next@${v}) is not a semver`);
    }
    fs.writeFileSync(path.join(cwd, '.knowledge-map.yaml'), 'stack:\n  - next@latest\n');
    const res = await runUpgradeCheckCommand(store, cwd, { targets: ['next@15.0.0'], json: false });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('"latest" (next in .knowledge-map.yaml) is not a semver');
  });

  it('keeps stdout valid JSON and stderr quiet with empty/invalid card ranges in the store', async () => {
    fs.writeFileSync(path.join(cwd, '.knowledge-map.yaml'), 'stack:\n  - next@14.2.0\n');
    writeCard('pattern-old', 'Old routing rule', '>=14 <15');
    writeCard('pattern-empty', 'Empty range', '');
    writeCard('pattern-junk', 'Junk range', 'not a range');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await runUpgradeCheckCommand(store, cwd, { targets: ['next@15.0.0'], json: true });
      expect(res.exitCode).toBe(0);
      const parsed = JSON.parse(res.stdout) as UpgradeCheck[];
      expect(parsed[0].stopApplying).toEqual(['pattern-old']);
      expect(parsed[0].stillApplying).toEqual([]);
      expect(spy.mock.calls.filter((c) => String(c[0]).includes('facets-intersect'))).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it('works when the store directory does not exist (nothing listed)', async () => {
    fs.writeFileSync(path.join(cwd, '.knowledge-map.yaml'), 'stack:\n  - next@14.2.0\n');
    const res = await runUpgradeCheckCommand(path.join(tmp, 'nope'), cwd, { targets: ['next@15.0.0'], json: false });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('Nothing changes for next');
    expect(fs.existsSync(path.join(tmp, 'nope'))).toBe(false);
  });
});
