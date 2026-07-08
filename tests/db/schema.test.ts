import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
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
