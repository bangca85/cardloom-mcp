import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { reconcileIndex } from '../../src/services/index-reconciler.js';
import {
  initializeSchema,
  insertCardRelationsAndStacks,
  deleteCardRelationsAndStacks,
} from '../../src/db/schema.js';

describe('schema.ts relations and stacks', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
  });

  it('creates tables and indexes successfully during initializeSchema', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row: any) => row.name);

    expect(tables).toContain('card_relations');
    expect(tables).toContain('card_stacks');

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index'")
      .all()
      .map((row: any) => row.name);

    expect(indexes).toContain('idx_card_relations_source');
    expect(indexes).toContain('idx_card_relations_target');
    expect(indexes).toContain('idx_card_relations_type');
    expect(indexes).toContain('idx_card_stacks_card');
    expect(indexes).toContain('idx_card_stacks_name');
  });

  it('upgrades an index created before the project column (Review Focus 2)', () => {
    const old = new Database(':memory:');
    initializeSchema(old);
    old.exec('ALTER TABLE cards DROP COLUMN project'); // simulate an old index without inline DDL
    old.exec(`INSERT INTO cards (id, type, status, title, scope, version_range, sensitivity, source_commit, provenance, body, created_at, updated_at, file_mtime)
      VALUES ('pattern-old', 'pattern', 'draft', 't', 'project', '*', 'normal', 'abc', 'agent-observation', 'b', 'x', 'x', '2026-01-01T00:00:00.000Z')`);
    expect((old.prepare('PRAGMA table_info(cards)').all() as Array<{ name: string }>).map((c) => c.name)).not.toContain('project');
    initializeSchema(old);
    expect((old.prepare('PRAGMA table_info(cards)').all() as Array<{ name: string }>).map((c) => c.name)).toContain('project');
    // Rows indexed before the column existed are marked stale so the next reconcile fills project in.
    expect((old.prepare("SELECT file_mtime FROM cards WHERE id = 'pattern-old'").get() as { file_mtime: string }).file_mtime).toBe('');
    initializeSchema(old); // idempotent
    old.close();
  });

  it('upgrades an index created before the source_repo column and marks rows for re-reading', () => {
    const old = new Database(':memory:');
    initializeSchema(old);
    old.exec('ALTER TABLE cards DROP COLUMN source_repo');
    old.exec(`INSERT INTO cards (id, type, status, title, scope, version_range, sensitivity, source_commit, provenance, body, created_at, updated_at, file_mtime)
      VALUES ('pattern-old', 'pattern', 'draft', 't', 'project', '*', 'normal', 'abc', 'agent-observation', 'b', 'x', 'x', '2026-01-01T00:00:00.000Z')`);
    const columns = () => (old.prepare('PRAGMA table_info(cards)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(columns()).not.toContain('source_repo');
    initializeSchema(old);
    expect(columns()).toContain('source_repo');
    expect((old.prepare("SELECT file_mtime FROM cards WHERE id = 'pattern-old'").get() as { file_mtime: string }).file_mtime).toBe('');
    initializeSchema(old); // idempotent
    old.close();
  });

  const projectColumnCount = (d: Database.Database): number =>
    (d.prepare('PRAGMA table_info(cards)').all() as Array<{ name: string }>).filter((c) => c.name === 'project').length;

  it('migrates safely when a second process adds the project column between check and ALTER', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cardloom-mcp-schema-'));
    const file = path.join(dir, 'index.db');
    const a = new Database(file);
    const b = new Database(file);
    try {
      initializeSchema(a);
      a.exec('ALTER TABLE cards DROP COLUMN project'); // old-shape index on disk
      // Make B observe the old shape, then let A migrate before B's ALTER runs (the race window).
      const realPrepare = b.prepare.bind(b);
      let raced = false;
      (b as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
        const stmt = realPrepare(sql);
        if (!raced && sql.includes('PRAGMA table_info(cards)')) {
          raced = true;
          const seen = (stmt as Database.Statement).all();
          initializeSchema(a);
          return { all: () => seen };
        }
        return stmt;
      };
      expect(() => initializeSchema(b)).not.toThrow();
      expect(raced).toBe(true);
      expect(projectColumnCount(b)).toBe(1);
      expect(projectColumnCount(a)).toBe(1);
    } finally {
      a.close();
      b.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('populates project from frontmatter after migrating an old-shape index and reconciling', async () => {
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'cardloom-mcp-schema-store-'));
    const old = new Database(':memory:');
    try {
      fs.mkdirSync(path.join(store, 'cards'));
      fs.writeFileSync(
        path.join(store, 'cards', 'pattern-old.md'),
        `---
type: pattern
scope: project
project: acme/billing-api
applies_to: [api]
stack: [node]
version_range: ">=1.0.0"
sensitivity: normal
source_commit: abc123
provenance: agent-observation
title: Old card
status: draft
---
Body of the old card.
`,
      );
      initializeSchema(old);
      await reconcileIndex(old, store); // index the row with the current shape
      old.exec('ALTER TABLE cards DROP COLUMN project'); // downgrade to the old shape, mtime already recorded
      initializeSchema(old);
      await reconcileIndex(old, store);
      expect((old.prepare("SELECT project FROM cards WHERE id = 'pattern-old'").get() as { project: string | null }).project).toBe(
        'acme/billing-api',
      );
    } finally {
      old.close();
      fs.rmSync(store, { recursive: true, force: true });
    }
  });

  it('inserts and deletes relations and stacks properly', () => {
    const cardId = 'decision-oauth-flow';
    const cardData = {
      supersedes: 'decision-old-oauth',
      conflicts_with: ['gotcha-session-lifetime', 'pattern-jwt-auth'],
      stack: ['typescript', 'oauth', 'backend'],
    };

    insertCardRelationsAndStacks(db, cardId, cardData);

    // Verify relations
    const relations = db
      .prepare('SELECT * FROM card_relations WHERE source_id = ? ORDER BY target_id')
      .all(cardId);
    expect(relations).toHaveLength(3);
    expect(relations[0]).toEqual({
      source_id: cardId,
      target_id: 'decision-old-oauth',
      relation_type: 'supersedes',
    });
    expect(relations[1]).toEqual({
      source_id: cardId,
      target_id: 'gotcha-session-lifetime',
      relation_type: 'conflicts_with',
    });
    expect(relations[2]).toEqual({
      source_id: cardId,
      target_id: 'pattern-jwt-auth',
      relation_type: 'conflicts_with',
    });

    // Verify stacks
    const stacks = db
      .prepare('SELECT * FROM card_stacks WHERE card_id = ? ORDER BY stack_name')
      .all(cardId);
    expect(stacks).toHaveLength(3);
    expect(stacks.map((s: any) => s.stack_name)).toEqual(['backend', 'oauth', 'typescript']);

    // Test Delete
    deleteCardRelationsAndStacks(db, cardId);
    expect(db.prepare('SELECT COUNT(*) as count FROM card_relations WHERE source_id = ?').get(cardId)).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) as count FROM card_stacks WHERE card_id = ?').get(cardId)).toEqual({ count: 0 });
  });

  it('implements idempotent delete-before-reinsert to avoid stale edges', () => {
    const cardId = 'decision-oauth-flow';
    const initialData = {
      supersedes: 'decision-old-oauth',
      conflicts_with: ['gotcha-session-lifetime'],
      stack: ['typescript', 'oauth'],
    };

    insertCardRelationsAndStacks(db, cardId, initialData);

    // Update with fewer connections
    const updatedData = {
      supersedes: null,
      conflicts_with: [],
      stack: ['typescript'],
    };

    insertCardRelationsAndStacks(db, cardId, updatedData);

    // Verify old relations are completely deleted
    const relations = db.prepare('SELECT * FROM card_relations WHERE source_id = ?').all(cardId);
    expect(relations).toHaveLength(0);

    const stacks = db.prepare('SELECT * FROM card_stacks WHERE card_id = ?').all(cardId);
    expect(stacks).toHaveLength(1);
    expect(stacks[0]).toEqual({ card_id: cardId, stack_name: 'typescript' });
  });

  it('ignores duplicate input tags/relations gracefully (INSERT OR IGNORE)', () => {
    const cardId = 'decision-oauth-flow';
    const duplicateData = {
      supersedes: 'decision-old-oauth',
      conflicts_with: ['gotcha-session-lifetime', 'gotcha-session-lifetime'],
      stack: ['typescript', 'typescript'],
    };

    // Should not crash and should deduplicate
    expect(() => insertCardRelationsAndStacks(db, cardId, duplicateData)).not.toThrow();

    const relations = db
      .prepare('SELECT * FROM card_relations WHERE source_id = ? AND relation_type = ?')
      .all(cardId, 'conflicts_with');
    expect(relations).toHaveLength(1);

    const stacks = db.prepare('SELECT * FROM card_stacks WHERE card_id = ?').all(cardId);
    expect(stacks).toHaveLength(1);
  });
});
