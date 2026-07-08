import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import { reconcileIndex } from '../../src/services/index-reconciler.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cardloom-mcp-cards-'));
}

function writeCard(storePath: string, filename: string, content: string): string {
  const cardsDir = path.join(storePath, 'cards');
  fs.mkdirSync(cardsDir, { recursive: true });
  const filePath = path.join(cardsDir, filename);
  fs.writeFileSync(filePath, content);
  return filePath;
}

const VALID_CARD = `---
type: pattern
scope: project
applies_to: [api]
stack: [node]
version_range: ">=1.0.0"
sensitivity: normal
source_commit: abc123
provenance: agent-observation
title: Use X pattern
status: draft
---
Body describing the X pattern in detail.
`;

const VALID_GOTCHA_CARD = `---
type: gotcha
scope: project
applies_to: [api]
stack: [node]
version_range: ">=1.0.0"
sensitivity: normal
source_commit: abc123
provenance: agent-observation
title: Weird crash on startup
status: draft
error_signature: "TypeError: Cannot read property foo"
---
Body describing the weird crash gotcha.
`;

describe('reconcileIndex (cards)', () => {
  let storePath: string;
  let db: Database.Database;

  beforeEach(() => {
    storePath = tmpDir();
    db = new Database(':memory:');
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(storePath, { recursive: true, force: true });
  });

  it('populates the cards table from cards/*.md', async () => {
    writeCard(storePath, 'pattern-use-x.md', VALID_CARD);

    await reconcileIndex(db, storePath);

    const rows = db.prepare('SELECT * FROM cards').all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('pattern-use-x');
    expect(rows[0]!.type).toBe('pattern');
    expect(rows[0]!.status).toBe('draft');
    expect(rows[0]!.title).toBe('Use X pattern');
    expect(JSON.parse(rows[0]!.stack as string)).toEqual(['node']);
  });

  it('creates the counters table empty', async () => {
    writeCard(storePath, 'pattern-use-x.md', VALID_CARD);

    await reconcileIndex(db, storePath);

    const count = db.prepare('SELECT COUNT(*) as c FROM counters').get() as { c: number };
    expect(count.c).toBe(0);
  });

  it('re-indexes a card whose mtime changed (hand-edited file)', async () => {
    const filePath = writeCard(storePath, 'pattern-use-x.md', VALID_CARD);
    await reconcileIndex(db, storePath);

    const futureTime = new Date(Date.now() + 10000);
    const updated = VALID_CARD.replace('Use X pattern', 'Use X pattern v2');
    fs.writeFileSync(filePath, updated);
    fs.utimesSync(filePath, futureTime, futureTime);

    await reconcileIndex(db, storePath);

    const row = db.prepare('SELECT title FROM cards WHERE id = ?').get('pattern-use-x') as { title: string };
    expect(row.title).toBe('Use X pattern v2');
  });

  it('removes a card from the index when its file is deleted', async () => {
    const filePath = writeCard(storePath, 'pattern-use-x.md', VALID_CARD);
    await reconcileIndex(db, storePath);
    expect(db.prepare('SELECT COUNT(*) as c FROM cards').get()).toEqual({ c: 1 });

    fs.unlinkSync(filePath);
    await reconcileIndex(db, storePath);

    expect(db.prepare('SELECT COUNT(*) as c FROM cards').get()).toEqual({ c: 0 });
  });

  it('skips a card with unparsable frontmatter and does not crash', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    writeCard(storePath, 'broken-card.md', '---\nfoo: [1,2\n---\nbroken body');
    writeCard(storePath, 'pattern-use-x.md', VALID_CARD);

    await expect(reconcileIndex(db, storePath)).resolves.not.toThrow();

    const rows = db.prepare('SELECT id FROM cards').all() as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual(['pattern-use-x']);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('[reconciler] skip'));

    errorSpy.mockRestore();
  });

  it('is idempotent — no spurious updates on second run', async () => {
    writeCard(storePath, 'pattern-use-x.md', VALID_CARD);
    await reconcileIndex(db, storePath);
    const row1 = db.prepare('SELECT file_mtime FROM cards WHERE id = ?').get('pattern-use-x') as { file_mtime: string };

    await reconcileIndex(db, storePath);
    const row2 = db.prepare('SELECT file_mtime FROM cards WHERE id = ?').get('pattern-use-x') as { file_mtime: string };

    expect(row2.file_mtime).toBe(row1.file_mtime);
  });

  it('makes title, body and error_signature searchable via cards_fts', async () => {
    writeCard(storePath, 'pattern-use-x.md', VALID_CARD);
    writeCard(storePath, 'gotcha-weird-crash.md', VALID_GOTCHA_CARD);

    await reconcileIndex(db, storePath);

    const byTitle = db
      .prepare('SELECT cards.id FROM cards_fts JOIN cards ON cards.rowid = cards_fts.rowid WHERE cards_fts MATCH ?')
      .all('pattern') as Array<{ id: string }>;
    expect(byTitle.map((r) => r.id)).toContain('pattern-use-x');

    const byBody = db
      .prepare('SELECT cards.id FROM cards_fts JOIN cards ON cards.rowid = cards_fts.rowid WHERE cards_fts MATCH ?')
      .all('detail') as Array<{ id: string }>;
    expect(byBody.map((r) => r.id)).toContain('pattern-use-x');

    const byErrorSignature = db
      .prepare('SELECT cards.id FROM cards_fts JOIN cards ON cards.rowid = cards_fts.rowid WHERE cards_fts MATCH ?')
      .all('TypeError') as Array<{ id: string }>;
    expect(byErrorSignature.map((r) => r.id)).toContain('gotcha-weird-crash');
  });

  it('out-of-band reconcile (editor edit + git pull simulation): edited card, new card, and new events all land in one pass (AC2, story 4.2)', async () => {
    const editedPath = writeCard(storePath, 'pattern-use-x.md', VALID_CARD);
    await reconcileIndex(db, storePath); // initial index, as if the server had already started once

    // Simulate: a human reviewer hand-edits a card while the server is stopped.
    const futureTime = new Date(Date.now() + 10000);
    fs.writeFileSync(editedPath, VALID_CARD.replace('Use X pattern', 'Use X pattern, hand-edited'));
    fs.utimesSync(editedPath, futureTime, futureTime);

    // Simulate: `git pull` brought in a brand new card and a usage-event file from another machine.
    writeCard(storePath, 'gotcha-weird-crash.md', VALID_GOTCHA_CARD);
    const eventsDir = path.join(storePath, 'events');
    fs.mkdirSync(eventsDir, { recursive: true });
    fs.writeFileSync(
      path.join(eventsDir, 'other-machine.jsonl'),
      JSON.stringify({ v: 1, card: 'pattern-use-x', outcome: 'confirmed', at: '2026-01-01T00:00:00Z' }) + '\n',
    );

    // Server startup — one reconcile pass must pick up all three changes at once.
    await reconcileIndex(db, storePath);

    const editedRow = db.prepare('SELECT title FROM cards WHERE id = ?').get('pattern-use-x') as { title: string };
    expect(editedRow.title).toBe('Use X pattern, hand-edited');

    const newRow = db.prepare('SELECT id FROM cards WHERE id = ?').get('gotcha-weird-crash');
    expect(newRow).toBeDefined();

    const counters = db.prepare('SELECT usage, success, failure FROM counters WHERE card_id = ?').get('pattern-use-x');
    expect(counters).toEqual({ usage: 1, success: 1, failure: 0 });
  });

  it('reconciles card_relations and card_stacks tables from cards metadata and cleans up when modified/deleted', async () => {
    const CARD_WITH_LINKS = `---
type: pattern
scope: project
applies_to: [api]
stack: [node, typescript]
version_range: ">=1.0.0"
sensitivity: normal
source_commit: abc123
provenance: agent-observation
title: Use X pattern
status: draft
supersedes: pattern-old-one
conflicts_with: [gotcha-weird-crash]
---
Body describing pattern.
`;

    // 1. Initial reconcile
    const filePath = writeCard(storePath, 'pattern-use-x.md', CARD_WITH_LINKS);
    await reconcileIndex(db, storePath);

    // Verify relations and stacks are created
    let relations = db.prepare('SELECT * FROM card_relations WHERE source_id = ? ORDER BY target_id').all('pattern-use-x');
    expect(relations).toHaveLength(2);
    expect(relations[0]).toEqual({ source_id: 'pattern-use-x', target_id: 'gotcha-weird-crash', relation_type: 'conflicts_with' });
    expect(relations[1]).toEqual({ source_id: 'pattern-use-x', target_id: 'pattern-old-one', relation_type: 'supersedes' });

    let stacks = db.prepare('SELECT * FROM card_stacks WHERE card_id = ? ORDER BY stack_name').all('pattern-use-x');
    expect(stacks).toHaveLength(2);
    expect(stacks.map((s: any) => s.stack_name)).toEqual(['node', 'typescript']);

    // 2. Update card (simulating editor edit) to remove relation and change stack
    const futureTime = new Date(Date.now() + 10000);
    const updatedCard = CARD_WITH_LINKS
      .replace('supersedes: pattern-old-one', 'supersedes: ')
      .replace('stack: [node, typescript]', 'stack: [node]');
    fs.writeFileSync(filePath, updatedCard);
    fs.utimesSync(filePath, futureTime, futureTime);

    await reconcileIndex(db, storePath);

    // Verify relation pattern-old-one (supersedes) is removed, but conflicts_with remains
    relations = db.prepare('SELECT * FROM card_relations WHERE source_id = ?').all('pattern-use-x');
    expect(relations).toHaveLength(1);
    expect(relations[0].target_id).toBe('gotcha-weird-crash');

    // Verify stack node is preserved, typescript is removed
    stacks = db.prepare('SELECT * FROM card_stacks WHERE card_id = ?').all('pattern-use-x');
    expect(stacks).toHaveLength(1);
    expect(stacks[0].stack_name).toBe('node');

    // 3. Delete card file
    fs.unlinkSync(filePath);
    await reconcileIndex(db, storePath);

    // Verify all relations and stacks are completely wiped out
    relations = db.prepare('SELECT * FROM card_relations WHERE source_id = ?').all('pattern-use-x');
    expect(relations).toHaveLength(0);

    stacks = db.prepare('SELECT * FROM card_stacks WHERE card_id = ?').all('pattern-use-x');
    expect(stacks).toHaveLength(0);
  });
});
