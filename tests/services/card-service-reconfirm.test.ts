import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import matter from 'gray-matter';
import type Database from 'better-sqlite3';
import { getDatabase, closeDatabase } from '../../src/db/database.js';
import { initKnowledgeStore } from '../../src/services/knowledge-store.js';
import { resetGit } from '../../src/services/git-service.js';
import { renderCard, saveLearningDraft, updateCardStatus } from '../../src/services/card-service.js';
import { cardFileHash } from '../../src/services/reconfirm-service.js';
import { InvalidTransitionError } from '../../src/types/errors.js';

const DAY = 24 * 60 * 60 * 1000;

describe('updateCardStatus: reconfirm (AD-9 amendment 2026-11-25)', () => {
  let storePath: string;
  let db: Database.Database;

  beforeEach(async () => {
    storePath = fs.mkdtempSync(path.join(os.tmpdir(), 'cardloom-mcp-reconfirm-'));
    await initKnowledgeStore(storePath);
    db = getDatabase(path.join(storePath, '.metadata', 'index.db'));
  });

  afterEach(() => {
    closeDatabase();
    resetGit();
    fs.rmSync(storePath, { recursive: true, force: true });
  });

  const draft = (title: string, appliesTo: string[] = ['api']) =>
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
    });

  const cardFile = (id: string): string => path.join(storePath, 'cards', `${id}.md`);
  const readFm = (id: string) => matter(fs.readFileSync(cardFile(id), 'utf-8')).data;
  const indexRow = (id: string) => db.prepare('SELECT * FROM cards WHERE id = ?').get(id);
  const git = (...args: string[]): string => execFileSync('git', ['-C', storePath, ...args], { encoding: 'utf-8' }).trim();

  /** A verified card whose last_verified is `ageDays` old, in the file and in the index. */
  async function verifiedCard(title: string, ageDays: number, method = 'chat-approval', appliesTo?: string[]): Promise<string> {
    const id = (await draft(title, appliesTo)).id;
    await updateCardStatus(db, storePath, { id, action: 'verify', by: 'alice', method });
    const old = new Date(Date.now() - ageDays * DAY).toISOString();
    const parsed = matter(fs.readFileSync(cardFile(id), 'utf-8'));
    parsed.data['last_verified'] = old;
    fs.writeFileSync(cardFile(id), matter.stringify(parsed.content, parsed.data));
    db.prepare('UPDATE cards SET last_verified = ? WHERE id = ?').run(old, id);
    return id;
  }

  const refusal = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: unknown) => e,
    );

  it('keeps status verified, refreshes last_verified, prefixes the method once, commits `knowledge: reconfirm <id>`', async () => {
    const id = await verifiedCard('Old retries', 400);
    expect(renderCard(db, id).flags.stale).toBe(true);
    const before = Date.now();

    const res = await updateCardStatus(db, storePath, { id, action: 'reconfirm', by: 'carol' });

    expect(res).toMatchObject({ id, status: 'verified', git_committed: true, index_updated: true });
    const fm = readFm(id);
    expect(fm['status']).toBe('verified');
    expect(fm['verified_by']).toBe('alice');
    expect(fm['verification_method']).toBe('reconfirmed:chat-approval');
    expect(new Date(fm['last_verified'] as string).getTime()).toBeGreaterThanOrEqual(before);
    expect(new Date(fm['last_verified'] as string).getTime()).toBeLessThanOrEqual(Date.now());
    expect(Object.keys(fm)).not.toContain('reconfirmed_by');
    expect(indexRow(id)).toMatchObject({
      status: 'verified',
      verified_by: 'alice',
      verification_method: 'reconfirmed:chat-approval',
      last_verified: fm['last_verified'],
    });
    expect(git('log', '-1', '--format=%s')).toBe(`knowledge: reconfirm ${id}`);
    expect(renderCard(db, id).flags.stale).toBeUndefined();
  });

  it('a second reconfirm keeps a single prefix, even over a hand-made chain', async () => {
    const id = await verifiedCard('Twice retries', 400);
    await updateCardStatus(db, storePath, { id, action: 'reconfirm' });
    await updateCardStatus(db, storePath, { id, action: 'reconfirm' });
    expect(readFm(id)['verification_method']).toBe('reconfirmed:chat-approval');

    const parsed = matter(fs.readFileSync(cardFile(id), 'utf-8'));
    parsed.data['verification_method'] = 'reconfirmed:reconfirmed:merged:acme/x@abc';
    fs.writeFileSync(cardFile(id), matter.stringify(parsed.content, parsed.data));
    await updateCardStatus(db, storePath, { id, action: 'reconfirm' });
    expect(readFm(id)['verification_method']).toBe('reconfirmed:merged:acme/x@abc');
  });

  it('leaves counters and the event log untouched', async () => {
    const id = await verifiedCard('Counted retries', 400);
    db.prepare('INSERT INTO counters (card_id, usage, success, failure) VALUES (?, 3, 2, 1)').run(id);
    const eventsBefore = fs.existsSync(path.join(storePath, 'events'))
      ? fs.readdirSync(path.join(storePath, 'events')).map((f) => fs.readFileSync(path.join(storePath, 'events', f), 'utf-8'))
      : [];

    await updateCardStatus(db, storePath, { id, action: 'reconfirm' });

    expect(db.prepare('SELECT usage, success, failure FROM counters WHERE card_id = ?').get(id)).toEqual({
      usage: 3,
      success: 2,
      failure: 1,
    });
    const eventsAfter = fs.existsSync(path.join(storePath, 'events'))
      ? fs.readdirSync(path.join(storePath, 'events')).map((f) => fs.readFileSync(path.join(storePath, 'events', f), 'utf-8'))
      : [];
    expect(eventsAfter).toEqual(eventsBefore);
    expect(Object.keys(readFm(id))).not.toContain('success');
  });

  it('uses "unknown" when the previous method is missing', async () => {
    const id = await verifiedCard('Unknown retries', 10);
    const parsed = matter(fs.readFileSync(cardFile(id), 'utf-8'));
    parsed.data['verification_method'] = 'reconfirmed:';
    fs.writeFileSync(cardFile(id), matter.stringify(parsed.content, parsed.data));
    await updateCardStatus(db, storePath, { id, action: 'reconfirm' });
    expect(readFm(id)['verification_method']).toBe('reconfirmed:unknown');
  });

  it.each([['draft'], ['deprecated']])('refuses a %s card with the standard invalid_transition shape and writes nothing', async (status) => {
    const id = (await draft(`Is ${status}`)).id;
    if (status === 'deprecated') await updateCardStatus(db, storePath, { id, action: 'deprecate', reason: 'obsolete' });
    const file = fs.readFileSync(cardFile(id), 'utf-8');
    const row = indexRow(id);
    const head = git('rev-parse', 'HEAD');

    const err = await refusal(updateCardStatus(db, storePath, { id, action: 'reconfirm' }));

    expect(err).toBeInstanceOf(InvalidTransitionError);
    const e = err as InvalidTransitionError;
    expect(e.code).toBe('invalid_transition');
    expect(e.details).toMatchObject({
      from: status,
      action: 'reconfirm',
      validTransitions: status === 'draft' ? ['verified', 'deprecated'] : [],
    });
    expect(fs.readFileSync(cardFile(id), 'utf-8')).toBe(file);
    expect(indexRow(id)).toEqual(row);
    expect(git('rev-parse', 'HEAD')).toBe(head);
  });

  it('refuses a card that needs review (refutes >= threshold) and writes nothing', async () => {
    const id = await verifiedCard('Refuted retries', 400);
    db.prepare('INSERT INTO counters (card_id, usage, success, failure) VALUES (?, 2, 0, 2)').run(id);
    const file = fs.readFileSync(cardFile(id), 'utf-8');
    const row = indexRow(id);
    const head = git('rev-parse', 'HEAD');

    const err = await refusal(updateCardStatus(db, storePath, { id, action: 'reconfirm' }));

    expect(err).toBeInstanceOf(InvalidTransitionError);
    expect((err as InvalidTransitionError).message).toBe(
      `${id} needs review (2 refutations): supersede it with a corrected card instead`,
    );
    expect((err as InvalidTransitionError).code).toBe('invalid_transition');
    expect(fs.readFileSync(cardFile(id), 'utf-8')).toBe(file);
    expect(indexRow(id)).toEqual(row);
    expect(git('rev-parse', 'HEAD')).toBe(head);
  });

  it('a wrong expected_hash is refused with the changed-since-listed message; file, index and git stay as they were', async () => {
    const id = await verifiedCard('Hashed retries', 400);
    const file = fs.readFileSync(cardFile(id), 'utf-8');
    const row = indexRow(id);
    const head = git('rev-parse', 'HEAD');

    const err = await refusal(updateCardStatus(db, storePath, { id, action: 'reconfirm', expected_hash: 'f'.repeat(64) }));

    expect(err).toBeInstanceOf(InvalidTransitionError);
    expect((err as InvalidTransitionError).message).toBe(`${id} changed since it was listed; list it again`);
    expect((err as InvalidTransitionError).code).toBe('invalid_transition');
    expect(fs.readFileSync(cardFile(id), 'utf-8')).toBe(file);
    expect(indexRow(id)).toEqual(row);
    expect(git('rev-parse', 'HEAD')).toBe(head);
  });

  it('a matching expected_hash goes through; an edit after listing makes the old hash fail', async () => {
    const id = await verifiedCard('Listed retries', 400);
    const hash = cardFileHash(storePath, id);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);

    // The file changes after it was listed: the listed hash no longer matches.
    fs.appendFileSync(cardFile(id), '\nA late edit.\n');
    const err = await refusal(updateCardStatus(db, storePath, { id, action: 'reconfirm', expected_hash: hash }));
    expect((err as InvalidTransitionError).message).toBe(`${id} changed since it was listed; list it again`);

    const fresh = cardFileHash(storePath, id);
    const res = await updateCardStatus(db, storePath, { id, action: 'reconfirm', expected_hash: fresh });
    expect(res.status).toBe('verified');
    expect(readFm(id)['verification_method']).toBe('reconfirmed:chat-approval');
  });

  it('does not touch a supersede target: a verified card with a stray supersedes is not run through verify logic', async () => {
    const oldId = await verifiedCard('Old way', 10);
    const newId = await verifiedCard('New way', 400, 'chat-approval', ['worker']);
    const parsed = matter(fs.readFileSync(cardFile(newId), 'utf-8'));
    parsed.data['supersedes'] = oldId;
    fs.writeFileSync(cardFile(newId), matter.stringify(parsed.content, parsed.data));

    await updateCardStatus(db, storePath, { id: newId, action: 'reconfirm' });

    expect(indexRow(oldId)).toMatchObject({ status: 'verified' });
    expect(readFm(oldId)['status']).toBe('verified');
    expect(git('log', '-1', '--format=%s')).toBe(`knowledge: reconfirm ${newId}`);
  });
});
