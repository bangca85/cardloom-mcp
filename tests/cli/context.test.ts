import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseContextArgs, runContext, CONTEXT_USAGE } from '../../src/cli/context.js';
import { initializeSchema } from '../../src/db/schema.js';
import { readKnowledgeMapDocument, splitTechVersion } from '../../src/utils/knowledge-map.js';

const FRESH = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

let tmp: string;
let work: string;
let indexPath: string;

function openIndex(file = indexPath, wal = false): Database.Database {
  const db = new Database(file);
  if (wal) db.pragma('journal_mode = WAL');
  initializeSchema(db);
  return db;
}

function seed(db: Database.Database, id: string, extra: { project?: string | null; scope?: string; stack?: string[]; status?: string } = {}): void {
  db.prepare(
    `INSERT INTO cards (id, type, status, title, stack, applies_to, scope, project, version_range, sensitivity,
       conflicts_with, source_commit, provenance, verified_by, verification_method, last_verified, body, created_at, updated_at)
     VALUES (?, 'pattern', ?, ?, ?, '["api"]', ?, ?, '*', 'normal', '[]', 'abc123', 'agent-observation', 'r', 'm', ?, ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
  ).run(
    id,
    extra.status ?? 'verified',
    `Title ${id}`,
    JSON.stringify(extra.stack ?? ['node']),
    extra.scope ?? 'project',
    extra.project === undefined ? 'acme/api' : extra.project,
    FRESH,
    `Rule ${id}. Detail.`,
  );
}

const snapshot = (dir: string): Record<string, string> =>
  Object.fromEntries(
    fs.readdirSync(dir).sort().map((f) => [f, createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex')]),
  );

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cardloom-context-'));
  work = path.join(tmp, 'work');
  fs.mkdirSync(work);
  indexPath = path.join(tmp, 'data', 'index.db');
  fs.mkdirSync(path.dirname(indexPath));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const args = { maxCards: 5, maxEstimatedTokens: 800 };
const writeMap = (text: string): void => fs.writeFileSync(path.join(work, '.knowledge-map.yaml'), text);

describe('parseContextArgs', () => {
  it('defaults to 5 cards and 800 estimated tokens', () => {
    expect(parseContextArgs([])).toEqual({ maxCards: 5, maxEstimatedTokens: 800 });
  });

  it('reads --project (normalised), --max-cards and --max-estimated-tokens', () => {
    expect(parseContextArgs(['--project', 'Acme/Billing', '--max-cards', '3', '--max-estimated-tokens', '400'])).toEqual({
      project: 'acme/billing',
      maxCards: 3,
      maxEstimatedTokens: 400,
    });
  });

  it.each([['--help'], ['-h'], ['--max-cards', '2', '--help']])('%j asks for the usage', (...argv) => {
    expect(parseContextArgs(argv)).toMatchObject({ help: true });
  });

  it.each([
    [['--project']],
    [['--project', 'not a key!']],
    [['--project', '../etc']],
    [['--max-cards']],
    [['--max-cards', '0']],
    [['--max-cards', '-1']],
    [['--max-cards', 'x']],
    [['--max-cards', '2.5']],
    [['--max-estimated-tokens', '0']],
    [['--max-estimated-tokens', 'many']],
    [['--bogus']],
    [['positional']],
  ])('rejects %j', (argv) => {
    expect(parseContextArgs(argv as string[])).toBeNull();
  });

  it('the usage names the options', () => {
    expect(CONTEXT_USAGE).toContain('Usage: context');
    expect(CONTEXT_USAGE).toContain('--project');
    expect(CONTEXT_USAGE).toContain('--max-cards');
    expect(CONTEXT_USAGE).toContain('--max-estimated-tokens');
  });
});

describe('knowledge map helpers', () => {
  it('splitTechVersion keeps a scoped name', () => {
    expect(splitTechVersion('nextjs@15')).toEqual({ tech: 'nextjs', version: '15' });
    expect(splitTechVersion('@scope/pkg@1.2')).toEqual({ tech: '@scope/pkg', version: '1.2' });
    expect(splitTechVersion('Node')).toEqual({ tech: 'node', version: undefined });
  });

  it('readKnowledgeMapDocument reports a missing and an unparseable map', () => {
    expect(readKnowledgeMapDocument(work)).toEqual({ ok: false, message: `no .knowledge-map.yaml in ${work}` });
    writeMap('stack: [unclosed\n');
    const bad = readKnowledgeMapDocument(work);
    expect(bad.ok).toBe(false);
  });
});

describe('runContext', () => {
  it('prints the cards of the map project, its aliases and global cards; exit 0', async () => {
    const db = openIndex();
    seed(db, 'pattern-own');
    seed(db, 'pattern-alias', { project: 'billing-api' });
    seed(db, 'pattern-global', { scope: 'global', project: null });
    seed(db, 'pattern-other', { project: 'other/x' });
    seed(db, 'pattern-draft', { status: 'draft' });
    db.close();
    writeMap('project: acme/api\naliases:\n  - billing-api\nstack:\n  - nextjs@15\n');
    const r = await runContext({ INDEX_DB_PATH: indexPath }, work, args);
    expect(r.exitCode).toBe(0);
    const lines = r.stdout.split('\n');
    expect(lines[0]).toBe('# Cardloom: verified cards for acme/api');
    expect(lines.at(-1)).toBe('Use search_knowledge/get_card for details.');
    expect(lines.slice(1, -1).map((l) => /\((.+?)\)/.exec(l)?.[1]).sort()).toEqual(['pattern-alias', 'pattern-global', 'pattern-own']);
  });

  it('accepts the legacy repo: key; project: wins when both are present', async () => {
    const db = openIndex();
    seed(db, 'pattern-own');
    seed(db, 'pattern-legacy', { project: 'legacy/repo' });
    db.close();
    writeMap('repo: legacy/repo\n');
    expect((await runContext({ INDEX_DB_PATH: indexPath }, work, args)).stdout).toContain('(pattern-legacy)');
    writeMap('repo: legacy/repo\nproject: acme/api\n');
    const both = (await runContext({ INDEX_DB_PATH: indexPath }, work, args)).stdout;
    expect(both).toContain('(pattern-own)');
    expect(both).not.toContain('(pattern-legacy)');
  });

  it('stack entries tech@version contribute their tech names to stack-scoped cards', async () => {
    const db = openIndex();
    seed(db, 'pattern-next', { scope: 'stack', project: null, stack: ['nextjs'] });
    seed(db, 'pattern-rust', { scope: 'stack', project: null, stack: ['rust'] });
    db.close();
    writeMap('project: acme/api\nstack:\n  - nextjs@15\n  - node\n');
    const out = (await runContext({ INDEX_DB_PATH: indexPath }, work, args)).stdout;
    expect(out).toContain('(pattern-next)');
    expect(out).not.toContain('(pattern-rust)');
  });

  it('--project overrides the map: the map is not read at all', async () => {
    const db = openIndex();
    seed(db, 'pattern-own');
    seed(db, 'pattern-cli', { project: 'cli/project' });
    db.close();
    writeMap('project: acme/api\n');
    const r = await runContext({ INDEX_DB_PATH: indexPath }, work, { ...args, project: 'cli/project' });
    expect(r.stdout).toContain('verified cards for cli/project');
    expect(r.stdout).toContain('(pattern-cli)');
    expect(r.stdout).not.toContain('(pattern-own)');
  });

  it('--project works without any map', async () => {
    const db = openIndex();
    seed(db, 'pattern-cli', { project: 'cli/project' });
    db.close();
    expect((await runContext({ INDEX_DB_PATH: indexPath }, work, { ...args, project: 'cli/project' })).stdout).toContain('(pattern-cli)');
  });

  it('honours --max-cards and --max-estimated-tokens', async () => {
    const db = openIndex();
    for (const n of ['a', 'b', 'c']) seed(db, `pattern-${n}`);
    db.close();
    writeMap('project: acme/api\n');
    const two = await runContext({ INDEX_DB_PATH: indexPath }, work, { ...args, maxCards: 2 });
    expect(two.stdout.split('\n')).toHaveLength(4);
    expect((await runContext({ INDEX_DB_PATH: indexPath }, work, { ...args, maxEstimatedTokens: 5 })).stdout).toBe('');
  });

  it.each([
    ['no map and no --project', () => undefined],
    ['an unparseable map', () => writeMap('project: [unclosed\n')],
    ['a map without a project', () => writeMap('stack:\n  - node\n')],
    ['a map whose project is not a key', () => writeMap('project: "not a key!"\n')],
  ])('%s: prints nothing, exit 0', async (_label, arrange) => {
    const db = openIndex();
    seed(db, 'pattern-global', { scope: 'global', project: null });
    seed(db, 'pattern-own');
    db.close();
    arrange();
    const before = snapshot(path.dirname(indexPath));
    expect(await runContext({ INDEX_DB_PATH: indexPath }, work, args)).toEqual({ stdout: '', exitCode: 0 });
    expect(snapshot(path.dirname(indexPath))).toEqual(before);
  });

  it('a missing index prints nothing, exit 0, and creates nothing', async () => {
    writeMap('project: acme/api\n');
    const missing = path.join(tmp, 'nowhere', 'deeper', 'index.db');
    expect(await runContext({ INDEX_DB_PATH: missing }, work, args)).toEqual({ stdout: '', exitCode: 0 });
    expect(fs.existsSync(path.join(tmp, 'nowhere'))).toBe(false);
    expect(fs.readdirSync(path.dirname(indexPath))).toEqual([]);
  });

  it('an unset or blank INDEX_DB_PATH prints nothing', async () => {
    writeMap('project: acme/api\n');
    expect(await runContext({}, work, args)).toEqual({ stdout: '', exitCode: 0 });
    expect(await runContext({ INDEX_DB_PATH: '  ' }, work, args)).toEqual({ stdout: '', exitCode: 0 });
  });

  it('a file that is not a database prints nothing, exit 0', async () => {
    writeMap('project: acme/api\n');
    fs.writeFileSync(indexPath, 'this is not sqlite at all, just text that is long enough to look like a header');
    const before = snapshot(path.dirname(indexPath));
    expect(await runContext({ INDEX_DB_PATH: indexPath }, work, args)).toEqual({ stdout: '', exitCode: 0 });
    expect(snapshot(path.dirname(indexPath))).toEqual(before);
  });

  it('an index from before the project/source_repo columns prints nothing, exit 0, and is not migrated', async () => {
    // The old DDL, spelled out on purpose: this is the schema an index built by an older version has.
    const old = new Database(indexPath);
    old.exec(`CREATE TABLE cards (id TEXT PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL, title TEXT NOT NULL,
      stack TEXT NOT NULL DEFAULT '[]', applies_to TEXT NOT NULL DEFAULT '[]', scope TEXT NOT NULL, version_range TEXT NOT NULL,
      sensitivity TEXT NOT NULL, source_commit TEXT NOT NULL, provenance TEXT NOT NULL, last_verified TEXT, body TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      INSERT INTO cards VALUES ('pattern-old', 'pattern', 'verified', 'Old', '[]', '[]', 'global', '*', 'normal', 'x', 'y', NULL, 'Body.', 'a', 'b');`);
    old.close();
    writeMap('project: acme/api\n');
    const before = snapshot(path.dirname(indexPath));
    expect(await runContext({ INDEX_DB_PATH: indexPath }, work, args)).toEqual({ stdout: '', exitCode: 0 });
    expect(snapshot(path.dirname(indexPath))).toEqual(before);
    const check = new Database(indexPath, { readonly: true });
    expect((check.prepare('PRAGMA table_info(cards)').all() as Array<{ name: string }>).some((c) => c.name === 'project')).toBe(false);
    check.close();
  });

  it('an index without the counters table prints nothing, exit 0', async () => {
    const db = openIndex();
    seed(db, 'pattern-own');
    db.exec('DROP TABLE counters');
    db.close();
    writeMap('project: acme/api\n');
    expect(await runContext({ INDEX_DB_PATH: indexPath }, work, args)).toEqual({ stdout: '', exitCode: 0 });
  });

  it('an empty store prints nothing, exit 0', async () => {
    openIndex().close();
    writeMap('project: acme/api\n');
    expect(await runContext({ INDEX_DB_PATH: indexPath }, work, args)).toEqual({ stdout: '', exitCode: 0 });
  });

  it('no eligible card prints nothing, exit 0', async () => {
    const db = openIndex();
    seed(db, 'pattern-other', { project: 'other/x' });
    db.close();
    writeMap('project: acme/api\n');
    expect(await runContext({ INDEX_DB_PATH: indexPath }, work, args)).toEqual({ stdout: '', exitCode: 0 });
  });

  it('reads a clean WAL-mode index (what the server leaves behind) without creating -wal/-shm files', async () => {
    const db = openIndex(indexPath, true);
    seed(db, 'pattern-own');
    db.close();
    expect(fs.readdirSync(path.dirname(indexPath))).toEqual(['index.db']);
    writeMap('project: acme/api\n');
    const before = snapshot(path.dirname(indexPath));
    const r = await runContext({ INDEX_DB_PATH: indexPath }, work, args);
    expect(r.stdout).toContain('(pattern-own)');
    expect(snapshot(path.dirname(indexPath))).toEqual(before);
  });

  it('reads a WAL-mode index while the server holds it open (committed rows are seen)', async () => {
    const db = openIndex(indexPath, true);
    seed(db, 'pattern-own');
    writeMap('project: acme/api\n');
    const r = await runContext({ INDEX_DB_PATH: indexPath }, work, args);
    expect(r.stdout).toContain('(pattern-own)');
    seed(db, 'pattern-second');
    expect((await runContext({ INDEX_DB_PATH: indexPath }, work, args)).stdout).toContain('(pattern-second)');
    db.close();
  });

  it('never writes to the index: the file is byte for byte the same after a run', async () => {
    const db = openIndex();
    seed(db, 'pattern-own');
    db.close();
    writeMap('project: acme/api\n');
    const before = snapshot(path.dirname(indexPath));
    await runContext({ INDEX_DB_PATH: indexPath }, work, args);
    expect(snapshot(path.dirname(indexPath))).toEqual(before);
    expect(fs.readdirSync(work)).toEqual(['.knowledge-map.yaml']);
  });
});
