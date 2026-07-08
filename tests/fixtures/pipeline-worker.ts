import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { initializeSchema } from '../../src/db/schema.js';
import { MutationPipeline } from '../../src/services/mutation-pipeline.js';

async function main(): Promise<void> {
  const [, , storePath, dbPath, workerId] = process.argv;
  if (!storePath || !dbPath || !workerId) {
    throw new Error('usage: pipeline-worker.ts <storePath> <dbPath> <workerId>');
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  initializeSchema(db);

  const pipeline = new MutationPipeline(db, storePath);
  const cardId = `pattern-worker-${workerId}`;
  const cardPath = path.join(storePath, 'cards', `${cardId}.md`);

  await pipeline.execute<{ workerId: string }>({
    writeFiles: () => {
      fs.mkdirSync(path.dirname(cardPath), { recursive: true });
      fs.writeFileSync(cardPath, `---\ntype: pattern\nstatus: draft\ntitle: Worker ${workerId}\n---\nBody for worker ${workerId}.\n`);
      return { result: { workerId }, tempFiles: [] };
    },
    filesToCommit: [`cards/${cardId}.md`],
    commitMessage: `knowledge: add ${cardId}`,
    updateIndex: (idxDb) => {
      idxDb.prepare(`
        INSERT INTO cards (
          id, type, status, title, domain, stack, applies_to, task_type, error_signature,
          scope, version_range, sensitivity, supersedes, conflicts_with, source_commit, provenance,
          verified_by, verification_method, last_verified, deprecation_reason, deprecated_at, deprecated_by,
          body, created_at, updated_at, file_mtime
        ) VALUES (
          @id, 'pattern', 'draft', @title, NULL, '[]', '[]', NULL, NULL,
          'project', '*', 'normal', NULL, '[]', 'abc123', 'agent-observation',
          NULL, NULL, NULL, NULL, NULL, NULL,
          'body', @now, @now, @now
        )
      `).run({ id: cardId, title: `Worker ${workerId}`, now: new Date().toISOString() });
    },
  });

  db.close();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
