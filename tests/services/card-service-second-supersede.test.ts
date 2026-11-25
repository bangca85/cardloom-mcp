import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import type Database from 'better-sqlite3';
import { getDatabase, closeDatabase } from '../../src/db/database.js';
import { initKnowledgeStore } from '../../src/services/knowledge-store.js';
import { resetGit } from '../../src/services/git-service.js';
import { renderCard, saveLearningDraft, updateCardStatus } from '../../src/services/card-service.js';
import { InvalidTransitionError } from '../../src/types/errors.js';

// D6 (owner-approved 2026-11-25): verify refuses a draft whose supersede target was already replaced by
// another card (AD-13 amendment). Same error class/code as any other invalid transition.
describe('updateCardStatus: verify refuses a second supersede', () => {
  let storePath: string;
  let db: Database.Database;

  beforeEach(async () => {
    storePath = fs.mkdtempSync(path.join(os.tmpdir(), 'cardloom-mcp-second-supersede-'));
    await initKnowledgeStore(storePath);
    db = getDatabase(path.join(storePath, '.metadata', 'index.db'));
  });

  afterEach(() => {
    closeDatabase();
    resetGit();
    fs.rmSync(storePath, { recursive: true, force: true });
  });

  const draft = (title: string, supersedes?: string, appliesTo: string[] = ['api']) =>
    saveLearningDraft(db, storePath, {
      title,
      type: 'pattern',
      scope: 'project',
      applies_to: appliesTo,
      stack: ['node'],
      version_range: '>=1.0.0',
      body: `Body of ${title}.`,
      source_commit: 'abc123',
      provenance: 'agent-observation',
      ...(supersedes ? { supersedes } : {}),
    });

  const commitCount = (): number =>
    Number(execFileSync('git', ['-C', storePath, 'rev-list', '--count', 'HEAD'], { encoding: 'utf-8' }).trim());
  const readCard = (id: string): string => fs.readFileSync(path.join(storePath, 'cards', `${id}.md`), 'utf-8');
  const indexRow = (id: string) => db.prepare('SELECT * FROM cards WHERE id = ?').get(id);

  it('refuses the second verify with invalid_transition naming the first successor, and writes nothing', async () => {
    const a = (await draft('Alpha retries')).id;
    await updateCardStatus(db, storePath, { id: a, action: 'verify' });
    const b = (await draft('Beta retries', a)).id;
    const c = (await draft('Gamma retries', a, ['worker'])).id;

    await updateCardStatus(db, storePath, { id: b, action: 'verify' });
    expect(indexRow(a)).toMatchObject({ status: 'deprecated', deprecation_reason: `superseded by ${b}` });

    const cFile = readCard(c);
    const aFile = readCard(a);
    const cRow = indexRow(c);
    const aRow = indexRow(a);
    const commits = commitCount();

    const err = await updateCardStatus(db, storePath, { id: c, action: 'verify' }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(InvalidTransitionError);
    const e = err as InvalidTransitionError;
    expect(e.code).toBe('invalid_transition');
    expect(e.message).toBe(`${a} is already superseded by ${b}`);
    expect(e.details).toMatchObject({ from: 'draft', action: 'verify', validTransitions: ['deprecated'] });

    expect(readCard(c)).toBe(cFile);
    expect(readCard(a)).toBe(aFile);
    expect(indexRow(c)).toEqual(cRow);
    expect(indexRow(a)).toEqual(aRow);
    expect(indexRow(c)).toMatchObject({ status: 'draft' });
    expect(commitCount()).toBe(commits);
    expect(renderCard(db, a).replacement).toEqual({ superseded_by: b, pending: [] });
  });

  it('a refused draft can still be deprecated (rejected)', async () => {
    const a = (await draft('Alpha retries')).id;
    await updateCardStatus(db, storePath, { id: a, action: 'verify' });
    const b = (await draft('Beta retries', a)).id;
    const c = (await draft('Gamma retries', a, ['worker'])).id;
    await updateCardStatus(db, storePath, { id: b, action: 'verify' });
    await expect(updateCardStatus(db, storePath, { id: c, action: 'verify' })).rejects.toThrow(InvalidTransitionError);
    const out = await updateCardStatus(db, storePath, { id: c, action: 'deprecate', reason: 'rejected: replaced by ' + b });
    expect(out.status).toBe('deprecated');
  });

  it('keeps today\'s behaviour when the target was deprecated for another reason', async () => {
    const a = (await draft('Alpha retries')).id;
    await updateCardStatus(db, storePath, { id: a, action: 'verify' });
    await updateCardStatus(db, storePath, { id: a, action: 'deprecate', reason: 'obsolete' });
    const b = (await draft('Beta retries', a)).id;

    const out = await updateCardStatus(db, storePath, { id: b, action: 'verify' });
    expect(out.status).toBe('verified');
    expect(indexRow(a)).toMatchObject({ status: 'deprecated', deprecation_reason: 'obsolete' });
  });

  it('allows verify when the target\'s superseded-by reason names this very card', async () => {
    const a = (await draft('Alpha retries')).id;
    await updateCardStatus(db, storePath, { id: a, action: 'verify' });
    const b = (await draft('Beta retries', a)).id;
    // Hand-edited / recovered state: target already says "superseded by <b>" while b is still a draft.
    await updateCardStatus(db, storePath, { id: a, action: 'deprecate', reason: `superseded by ${b}` });
    const out = await updateCardStatus(db, storePath, { id: b, action: 'verify' });
    expect(out.status).toBe('verified');
    expect(indexRow(a)).toMatchObject({ deprecation_reason: `superseded by ${b}` });
  });

  it('does not refuse (and get_card shows no replacement) when the reason names a successor that does not exist', async () => {
    const a = (await draft('Alpha retries')).id;
    await updateCardStatus(db, storePath, { id: a, action: 'verify' });
    await updateCardStatus(db, storePath, { id: a, action: 'deprecate', reason: 'superseded by pattern-typo' });
    expect(renderCard(db, a).replacement).toBeUndefined();
    const b = (await draft('Beta retries', a)).id;

    const out = await updateCardStatus(db, storePath, { id: b, action: 'verify' });
    expect(out.status).toBe('verified');
  });

  it('does not refuse when the named successor exists but does not declare supersedes = the target', async () => {
    const a = (await draft('Alpha retries')).id;
    await updateCardStatus(db, storePath, { id: a, action: 'verify' });
    const other = (await draft('Unrelated rule', undefined, ['worker'])).id;
    await updateCardStatus(db, storePath, { id: a, action: 'deprecate', reason: `superseded by ${other}` });
    expect(renderCard(db, a).replacement).toBeUndefined();
    const b = (await draft('Beta retries', a)).id;
    const out = await updateCardStatus(db, storePath, { id: b, action: 'verify' });
    expect(out.status).toBe('verified');
  });

  it('verifies a draft without supersedes as before', async () => {
    const a = (await draft('Alpha retries')).id;
    const out = await updateCardStatus(db, storePath, { id: a, action: 'verify' });
    expect(out.status).toBe('verified');
  });

  it('keeps today\'s behaviour when the supersede target does not exist', async () => {
    const a = (await draft('Alpha retries')).id;
    await updateCardStatus(db, storePath, { id: a, action: 'verify' });
    const b = (await draft('Beta retries', a)).id;
    // The target disappears from disk and index after the draft was saved.
    fs.rmSync(path.join(storePath, 'cards', `${a}.md`));
    db.prepare('DELETE FROM cards WHERE id = ?').run(a);
    const out = await updateCardStatus(db, storePath, { id: b, action: 'verify' });
    expect(out.status).toBe('verified');
  });
});
