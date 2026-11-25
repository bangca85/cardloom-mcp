import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import matter from 'gray-matter';
import type Database from 'better-sqlite3';
import { getDatabase, closeDatabase } from '../../src/db/database.js';
import { initKnowledgeStore } from '../../src/services/knowledge-store.js';
import { resetGit } from '../../src/services/git-service.js';
import { saveLearningDraft, updateCardStatus } from '../../src/services/card-service.js';
import { cardFileHash, listStaleCards, reconfirmCards } from '../../src/services/reconfirm-service.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-11-25T12:00:00.000Z');

describe('reconfirm-service', () => {
  let storePath: string;
  let db: Database.Database;

  beforeEach(async () => {
    storePath = fs.mkdtempSync(path.join(os.tmpdir(), 'cardloom-mcp-reconfirm-svc-'));
    await initKnowledgeStore(storePath);
    db = getDatabase(path.join(storePath, '.metadata', 'index.db'));
  });

  afterEach(() => {
    closeDatabase();
    resetGit();
    fs.rmSync(storePath, { recursive: true, force: true });
  });

  const cardFile = (id: string): string => path.join(storePath, 'cards', `${id}.md`);

  /** A card verified for real, then its last_verified set to `lastVerified` in file and index. */
  async function verified(title: string, lastVerified: string, sensitivity: 'normal' | 'restricted' = 'normal'): Promise<string> {
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
        sensitivity,
      })
    ).id;
    await updateCardStatus(db, storePath, { id, action: 'verify', by: 'alice' });
    const parsed = matter(fs.readFileSync(cardFile(id), 'utf-8'));
    parsed.data['last_verified'] = lastVerified;
    fs.writeFileSync(cardFile(id), matter.stringify(parsed.content, parsed.data));
    db.prepare('UPDATE cards SET last_verified = ? WHERE id = ?').run(lastVerified, id);
    return id;
  }

  const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();

  describe('cardFileHash', () => {
    it('is the sha256 hex of the card file bytes', async () => {
      const id = await verified('Hash me', ago(DAY));
      const expected = crypto.createHash('sha256').update(fs.readFileSync(cardFile(id))).digest('hex');
      expect(cardFileHash(storePath, id)).toBe(expected);
    });
  });

  describe('listStaleCards', () => {
    it('lists only stale verified cards, oldest first, with age, hash and the needs_review marker', async () => {
      const fresh = await verified('Fresh card', ago(10 * DAY));
      const older = await verified('Older card', ago(400 * DAY));
      const oldest = await verified('Oldest card', ago(900 * DAY));
      const restricted = await verified('Restricted card', ago(500 * DAY), 'restricted');
      const reviewed = await verified('Refuted card', ago(300 * DAY));
      db.prepare('INSERT INTO counters (card_id, usage, success, failure) VALUES (?, 2, 0, 2)').run(reviewed);
      const draft = (
        await saveLearningDraft(db, storePath, {
          title: 'Still a draft',
          type: 'pattern',
          scope: 'project',
          applies_to: ['draft'],
          stack: ['node'],
          version_range: '>=1.0.0',
          body: 'Draft body.',
          source_commit: 'abc123',
          provenance: 'agent-observation',
        })
      ).id;
      const retired = await verified('Retired card', ago(700 * DAY));
      await updateCardStatus(db, storePath, { id: retired, action: 'deprecate', reason: 'obsolete' });

      const list = listStaleCards(db, storePath, NOW);

      expect(list.map((c) => c.id)).toEqual([oldest, restricted, older, reviewed]);
      expect(list.map((c) => c.id)).not.toContain(fresh);
      expect(list.map((c) => c.id)).not.toContain(draft);
      expect(list.map((c) => c.id)).not.toContain(retired);
      expect(list[0]).toEqual({
        id: oldest,
        title: 'Oldest card',
        lastVerified: ago(900 * DAY),
        ageDays: 900,
        hash: cardFileHash(storePath, oldest),
        needsReview: false,
      });
      expect(list.map((c) => c.needsReview)).toEqual([false, false, false, true]);
    });

    it('the boundary is STALE_THRESHOLD_DAYS exclusive: exactly 180 days is not stale, one second more is', async () => {
      const exact = await verified('Exactly on the line', ago(180 * DAY));
      const over = await verified('One second over', ago(180 * DAY + 1000));

      expect(listStaleCards(db, storePath, NOW).map((c) => c.id)).toEqual([over]);
      expect(listStaleCards(db, storePath, NOW).map((c) => c.id)).not.toContain(exact);
    });
  });

  describe('reconfirmCards', () => {
    it('applies the good entries in order and collects every refusal without throwing', async () => {
      const a = await verified('Card a', ago(400 * DAY));
      const b = await verified('Card b', ago(401 * DAY));
      const c = await verified('Card c', ago(402 * DAY));
      const hashA = cardFileHash(storePath, a);
      const hashB = cardFileHash(storePath, b);
      const staleHashC = cardFileHash(storePath, c);
      fs.appendFileSync(cardFile(c), '\nEdited after listing.\n');

      const res = await reconfirmCards(
        db,
        storePath,
        [
          { id: a, hash: hashA },
          { id: c, hash: staleHashC },
          { id: 'pattern-does-not-exist', hash: 'a'.repeat(64) },
          { id: b, hash: hashB },
        ],
        'carol',
      );

      expect(res).toEqual({
        reconfirmed: [a, b],
        refused: [
          { id: c, reason: `${c} changed since it was listed; list it again` },
          { id: 'pattern-does-not-exist', reason: 'Not found: pattern-does-not-exist' },
        ],
      });
      expect(matter(fs.readFileSync(cardFile(a), 'utf-8')).data['verification_method']).toBe('reconfirmed:chat-approval');
      expect(matter(fs.readFileSync(cardFile(c), 'utf-8')).data['verification_method']).toBe('chat-approval');
      const subjects = execFileSync('git', ['-C', storePath, 'log', '-2', '--format=%s'], { encoding: 'utf-8' }).trim().split('\n');
      expect(subjects).toEqual([`knowledge: reconfirm ${b} (by carol)`, `knowledge: reconfirm ${a} (by carol)`]);
    });
  });
});
