import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import matter from 'gray-matter';
import { getDatabase, closeDatabase } from '../../src/db/database.js';
import { initKnowledgeStore } from '../../src/services/knowledge-store.js';
import { resetGit } from '../../src/services/git-service.js';
import { saveLearningDraft, updateCardStatus } from '../../src/services/card-service.js';
import { cardFileHash } from '../../src/services/reconfirm-service.js';
import {
  RECONFIRM_USAGE,
  parseReconfirmArgs,
  runReconfirmCommand,
  runReconfirmStale,
} from '../../src/cli/reconfirm.js';

const DAY = 24 * 60 * 60 * 1000;
const H64 = 'a'.repeat(64);

describe('parseReconfirmArgs', () => {
  it('--stale, with and without --json', () => {
    expect(parseReconfirmArgs(['--stale'])).toEqual({ stale: true, json: false });
    expect(parseReconfirmArgs(['--stale', '--json'])).toEqual({ stale: true, json: true });
  });

  it('--confirm takes a comma list of id@hash and an optional --by', () => {
    expect(parseReconfirmArgs(['--confirm', `pattern-a@${H64},gotcha-b@${H64}`])).toEqual({
      confirm: [
        { id: 'pattern-a', hash: H64 },
        { id: 'gotcha-b', hash: H64 },
      ],
    });
    expect(parseReconfirmArgs(['--confirm', `pattern-a@${H64}`, '--by', 'carol'])).toEqual({
      confirm: [{ id: 'pattern-a', hash: H64 }],
      by: 'carol',
    });
  });

  it('--help and -h set help', () => {
    expect(parseReconfirmArgs(['--help'])).toEqual({ help: true });
    expect(parseReconfirmArgs(['-h'])).toEqual({ help: true });
  });

  it.each([
    [[]],
    [['--bogus']],
    [['--stale', '--bogus']],
    [['--json']],
    [['--confirm']],
    [['--confirm', '']],
    [['--confirm', 'pattern-a']],
    [['--confirm', 'pattern-a@short']],
    [['--confirm', `pattern-a@${H64},`]],
    [['--confirm', `pattern-a@${H64}`, '--by']],
    [['--confirm', `pattern-a@${H64}`, '--json']],
    [['--stale', '--confirm', `pattern-a@${H64}`]],
    [['--stale', '--by', 'carol']],
  ])('%j is rejected', (argv) => {
    expect(parseReconfirmArgs(argv as string[])).toBeNull();
  });

  it('the usage names both modes and says --by is recorded only in the output line', () => {
    expect(RECONFIRM_USAGE).toContain('Usage: reconfirm');
    expect(RECONFIRM_USAGE).toContain('--stale');
    expect(RECONFIRM_USAGE).toContain('--confirm');
    expect(RECONFIRM_USAGE).toContain('--by');
    expect(RECONFIRM_USAGE).toContain('REVIEWER_NAME');
    expect(RECONFIRM_USAGE).toContain("recorded in nothing but this command's output");
  });
});

describe('reconfirm CLI on a temp store', () => {
  let storePath: string;
  let indexPath: string;

  beforeEach(async () => {
    storePath = fs.mkdtempSync(path.join(os.tmpdir(), 'cardloom-mcp-reconfirm-cli-'));
    indexPath = path.join(storePath, '.metadata', 'index.db');
    await initKnowledgeStore(storePath);
  });

  afterEach(() => {
    closeDatabase();
    resetGit();
    fs.rmSync(storePath, { recursive: true, force: true });
  });

  const cardFile = (id: string): string => path.join(storePath, 'cards', `${id}.md`);
  const git = (...args: string[]): string => execFileSync('git', ['-C', storePath, ...args], { encoding: 'utf-8' }).trim();

  /** Verified card with its last_verified moved `ageDays` back, in the file only (the CLIs rebuild the index). */
  async function staleCard(title: string, ageDays: number): Promise<string> {
    const db = getDatabase(indexPath);
    const id = (
      await saveLearningDraft(db, storePath, {
        title,
        type: 'pattern',
        scope: 'project',
        applies_to: [title.toLowerCase().replace(/\W+/g, '-')],
        stack: ['node'],
        version_range: '>=1.0.0',
        body: `Body of ${title}.`,
        source_commit: 'abc123',
        provenance: 'agent-observation',
      })
    ).id;
    await updateCardStatus(db, storePath, { id, action: 'verify', by: 'alice' });
    const parsed = matter(fs.readFileSync(cardFile(id), 'utf-8'));
    parsed.data['last_verified'] = new Date(Date.now() - ageDays * DAY).toISOString();
    fs.writeFileSync(cardFile(id), matter.stringify(parsed.content, parsed.data));
    return id;
  }

  it('--stale lists id, title, age, hash and the needs_review marker; fresh cards are not listed', async () => {
    const old = await staleCard('Old retries', 400);
    const refuted = await staleCard('Refuted retries', 300);
    const fresh = await staleCard('Fresh retries', 5);
    fs.writeFileSync(
      path.join(storePath, 'events', 'm1.jsonl'),
      [1, 2].map((i) => JSON.stringify({ v: 1, card: refuted, outcome: 'refuted', at: `2026-11-0${i}T00:00:00.000Z` })).join('\n') + '\n',
    );
    closeDatabase();

    const out = await runReconfirmStale(storePath, { json: false });
    const lines = out.split('\n');

    expect(lines[0]).toBe('2 stale card(s) (last verified more than 180 days ago, oldest first):');
    expect(lines[1]).toBe(`  ${old}  Old retries  400 days  ${cardFileHash(storePath, old)}`);
    expect(lines[2]).toBe(
      `  ${refuted}  Refuted retries  300 days  ${cardFileHash(storePath, refuted)}  needs_review (cannot be re-confirmed: supersede it)`,
    );
    expect(out).not.toContain(fresh);
    expect(lines[lines.length - 1]).toBe('Re-confirm with: cardloom-mcp reconfirm --confirm <id>@<hash>[,<id>@<hash>...] [--by <name>]');
  });

  it('--stale --json prints the list as JSON; an empty store prints that there is nothing and does not create it', async () => {
    const old = await staleCard('Json retries', 400);
    closeDatabase();
    const parsed = JSON.parse(await runReconfirmStale(storePath, { json: true })) as Array<Record<string, unknown>>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ id: old, title: 'Json retries', ageDays: 400, needsReview: false });
    expect(parsed[0]?.['hash']).toBe(cardFileHash(storePath, old));

    const missing = path.join(storePath, 'nope');
    expect(await runReconfirmStale(missing, { json: false })).toBe('No stale cards.');
    expect(JSON.parse(await runReconfirmStale(missing, { json: true }))).toEqual([]);
    expect(fs.existsSync(missing)).toBe(false);
  });

  it('--confirm applies the good entries, reports each refusal on stderr and exits 1', async () => {
    const a = await staleCard('Card a', 400);
    const b = await staleCard('Card b', 401);
    const hashA = cardFileHash(storePath, a);
    const hashB = cardFileHash(storePath, b);
    closeDatabase();
    resetGit();

    const res = await runReconfirmCommand(storePath, indexPath, {
      confirm: [
        { id: a, hash: hashA },
        { id: b, hash: 'b'.repeat(64) },
        { id: 'pattern-missing', hash: H64 },
      ],
      by: 'carol',
    });

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe(`reconfirmed ${a} (by carol)`);
    expect(res.stderr.split('\n')).toEqual([
      `refused ${b}: ${b} changed since it was listed; list it again`,
      'refused pattern-missing: Not found: pattern-missing',
    ]);
    expect(matter(fs.readFileSync(cardFile(a), 'utf-8')).data['verification_method']).toBe('reconfirmed:chat-approval');
    expect(matter(fs.readFileSync(cardFile(b), 'utf-8')).data['verification_method']).toBe('chat-approval');
    expect(git('log', '-1', '--format=%s')).toBe(`knowledge: reconfirm ${a}`);
    expect(hashB).toBe(cardFileHash(storePath, b));
  });

  it('--confirm with everything good exits 0 and prints one line per card; --by defaults to REVIEWER_NAME', async () => {
    const a = await staleCard('Good a', 400);
    const b = await staleCard('Good b', 401);
    const entries = [a, b].map((id) => ({ id, hash: cardFileHash(storePath, id) }));
    closeDatabase();
    resetGit();
    const prev = process.env['REVIEWER_NAME'];
    process.env['REVIEWER_NAME'] = 'dana';
    try {
      const res = await runReconfirmCommand(storePath, indexPath, { confirm: entries });
      expect(res).toEqual({ stdout: `reconfirmed ${a} (by dana)\nreconfirmed ${b} (by dana)`, stderr: '', exitCode: 0 });
    } finally {
      if (prev === undefined) delete process.env['REVIEWER_NAME'];
      else process.env['REVIEWER_NAME'] = prev;
    }
  });

  it('--confirm against a store that does not exist refuses every entry and creates nothing', async () => {
    const missing = path.join(storePath, 'nope');
    const res = await runReconfirmCommand(missing, path.join(missing, 'index.db'), { confirm: [{ id: 'pattern-x', hash: H64 }], by: 'carol' });
    expect(res).toEqual({ stdout: '', stderr: 'refused pattern-x: Not found: pattern-x', exitCode: 1 });
    expect(fs.existsSync(missing)).toBe(false);
  });
});
