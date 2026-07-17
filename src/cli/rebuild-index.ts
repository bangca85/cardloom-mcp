import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { lock } from 'proper-lockfile';
import { config } from '../config/env.js';
import { getDatabase, closeDatabase } from '../db/database.js';
import { reconcileIndex } from '../services/index-reconciler.js';

/**
 * Rebuilds index.db from scratch: cards/*.md + events/*.jsonl are the only source of truth
 * (AD-2). This CLI never touches the knowledge store itself — read-only w.r.t. cards/events,
 * no git commit (NFR2: rebuild changes nothing about the store).
 */
export async function rebuildIndex(): Promise<void> {
  const startTime = Date.now();
  const dbPath = config.indexDbPath;
  const lockDir = path.dirname(dbPath);
  fs.mkdirSync(lockDir, { recursive: true });

  let releaseLock: (() => Promise<void>) | undefined;
  try {
    releaseLock = await lock(path.join(lockDir, 'write'), {
      realpath: false,
      lockfilePath: path.join(lockDir, 'write.lock'),
      stale: 10000,
      retries: { retries: 5, minTimeout: 100, maxTimeout: 2000 },
      onCompromised: (err) => {
        console.error('[rebuild-index] write lock compromised:', err.message);
      },
    });
  } catch (err) {
    throw new Error(`[rebuild-index] could not acquire write lock (is the server running?): ${(err as Error).message}`);
  }

  try {
    let previousCount: number | undefined;
    if (fs.existsSync(dbPath)) {
      try {
        const previousDb = new Database(dbPath, { readonly: true });
        try {
          previousCount = (previousDb.prepare('SELECT COUNT(*) as c FROM cards').get() as { c: number }).c;
        } finally {
          previousDb.close();
        }
      } catch {
        previousCount = undefined;
      }
    }

    for (const suffix of ['', '-wal', '-shm']) {
      const target = `${dbPath}${suffix}`;
      if (fs.existsSync(target)) {
        fs.unlinkSync(target);
      }
    }

    const db = getDatabase(dbPath);
    await reconcileIndex(db, config.knowledgeStorePath);

    const cardCount = (db.prepare('SELECT COUNT(*) as c FROM cards').get() as { c: number }).c;
    const counterRows = (db.prepare('SELECT COUNT(*) as c FROM counters').get() as { c: number }).c;
    const elapsed = Date.now() - startTime;
    console.error(`[rebuild-index] done: ${cardCount} cards, ${counterRows} counter rows (${elapsed}ms)`);

    if (previousCount !== undefined && cardCount < previousCount * 0.8) {
      console.error(
        '[rebuild-index] warning: active card count dropped from ' +
          previousCount +
          ' to ' +
          cardCount +
          ' — check for a reconcile bug or missing files',
      );
    }
  } finally {
    closeDatabase();
    if (releaseLock) {
      await releaseLock();
    }
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  rebuildIndex().catch((err: unknown) => {
    console.error('[rebuild-index] failed:', err);
    process.exit(1);
  });
}
