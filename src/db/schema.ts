import type Database from 'better-sqlite3';

export function initializeSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cards (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      title TEXT NOT NULL,
      domain TEXT,
      stack TEXT NOT NULL DEFAULT '[]',
      applies_to TEXT NOT NULL DEFAULT '[]',
      task_type TEXT,
      error_signature TEXT,
      scope TEXT NOT NULL,
      version_range TEXT NOT NULL,
      sensitivity TEXT NOT NULL,
      supersedes TEXT,
      conflicts_with TEXT NOT NULL DEFAULT '[]',
      source_commit TEXT NOT NULL,
      provenance TEXT NOT NULL,
      verified_by TEXT,
      verification_method TEXT,
      last_verified TEXT,
      deprecation_reason TEXT,
      deprecated_at TEXT,
      deprecated_by TEXT,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      file_mtime TEXT NOT NULL DEFAULT ''
    );

    -- No FK to cards(id): counters are folded purely from events/*.jsonl (AD-4) and must
    -- tolerate events for cards no longer on disk (deleted/renamed) without ever failing the fold.
    CREATE TABLE IF NOT EXISTS counters (
      card_id TEXT PRIMARY KEY,
      usage INTEGER NOT NULL DEFAULT 0,
      success INTEGER NOT NULL DEFAULT 0,
      failure INTEGER NOT NULL DEFAULT 0
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS cards_fts USING fts5(
      title,
      body,
      error_signature,
      content='cards',
      content_rowid='rowid',
      tokenize='porter unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS cards_ai AFTER INSERT ON cards BEGIN
      INSERT INTO cards_fts(rowid, title, body, error_signature)
      VALUES (new.rowid, new.title, new.body, new.error_signature);
    END;

    CREATE TRIGGER IF NOT EXISTS cards_ad AFTER DELETE ON cards BEGIN
      INSERT INTO cards_fts(cards_fts, rowid, title, body, error_signature)
      VALUES('delete', old.rowid, old.title, old.body, old.error_signature);
    END;

    DROP TRIGGER IF EXISTS cards_au;
    CREATE TRIGGER cards_au AFTER UPDATE OF title, body, error_signature ON cards BEGIN
      INSERT INTO cards_fts(cards_fts, rowid, title, body, error_signature)
      VALUES('delete', old.rowid, old.title, old.body, old.error_signature);
      INSERT INTO cards_fts(rowid, title, body, error_signature)
      VALUES (new.rowid, new.title, new.body, new.error_signature);
    END;

    CREATE TABLE IF NOT EXISTS card_relations (
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      relation_type TEXT NOT NULL,
      PRIMARY KEY (source_id, target_id, relation_type)
    );

    CREATE INDEX IF NOT EXISTS idx_card_relations_source ON card_relations(source_id);
    CREATE INDEX IF NOT EXISTS idx_card_relations_target ON card_relations(target_id);
    CREATE INDEX IF NOT EXISTS idx_card_relations_type ON card_relations(relation_type);

    CREATE TABLE IF NOT EXISTS card_stacks (
      card_id TEXT NOT NULL,
      stack_name TEXT NOT NULL,
      PRIMARY KEY (card_id, stack_name)
    );

    CREATE INDEX IF NOT EXISTS idx_card_stacks_card ON card_stacks(card_id);
    CREATE INDEX IF NOT EXISTS idx_card_stacks_name ON card_stacks(stack_name);
  `);
}

interface RelationSourceCard {
  supersedes?: string | null;
  conflicts_with?: string[];
  stack?: string[];
}

export function insertCardRelationsAndStacks(
  db: Database.Database,
  cardId: string,
  card: RelationSourceCard,
): void {
  // DELETE-before-REINSERT to prevent stale/orphan relations
  db.prepare('DELETE FROM card_relations WHERE source_id = ?').run(cardId);
  db.prepare('DELETE FROM card_stacks WHERE card_id = ?').run(cardId);

  // Insert supersedes relation
  if (card.supersedes) {
    db.prepare(`
      INSERT OR IGNORE INTO card_relations (source_id, target_id, relation_type)
      VALUES (?, ?, 'supersedes')
    `).run(cardId, card.supersedes);
  }

  // Insert conflicts_with relations
  if (Array.isArray(card.conflicts_with)) {
    const insertRelation = db.prepare(`
      INSERT OR IGNORE INTO card_relations (source_id, target_id, relation_type)
      VALUES (?, ?, 'conflicts_with')
    `);
    for (const targetId of card.conflicts_with) {
      if (targetId && targetId.trim() !== '') {
        insertRelation.run(cardId, targetId.trim());
      }
    }
  }

  // Insert stacks
  if (Array.isArray(card.stack)) {
    const insertStack = db.prepare(`
      INSERT OR IGNORE INTO card_stacks (card_id, stack_name)
      VALUES (?, ?)
    `);
    for (const stackName of card.stack) {
      if (stackName && stackName.trim() !== '') {
        insertStack.run(cardId, stackName.trim());
      }
    }
  }
}

export function deleteCardRelationsAndStacks(db: Database.Database, cardId: string): void {
  db.prepare('DELETE FROM card_relations WHERE source_id = ? OR target_id = ?').run(cardId, cardId);
  db.prepare('DELETE FROM card_stacks WHERE card_id = ?').run(cardId);
}
