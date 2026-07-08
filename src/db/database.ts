import BetterSqlite3 from 'better-sqlite3';
import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { initializeSchema } from './schema.js';

let db: Database.Database | null = null;

export function getDatabase(dbPath: string): Database.Database {
  if (db) {
    if (db.name === dbPath) {
      return db;
    }
    db.close();
    db = null;
  }

  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new BetterSqlite3(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  initializeSchema(db);

  return db;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}
