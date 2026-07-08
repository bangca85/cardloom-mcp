import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { glob } from 'glob';
import matter from 'gray-matter';
import { validateCardLenient } from '../types/card-schema.js';
import { ValidationError } from '../types/errors.js';
import { foldAllEvents } from './event-log-service.js';
import { insertCardRelationsAndStacks, deleteCardRelationsAndStacks } from '../db/schema.js';

interface DbCardRecord {
  id: string;
  file_mtime: string;
}

export async function reconcileIndex(db: Database.Database, knowledgeStorePath: string): Promise<void> {
  const startTime = Date.now();

  const pattern = path.join(knowledgeStorePath, 'cards/*.md');
  const files = await glob(pattern, { nodir: true });

  const dbRecords = db.prepare('SELECT id, file_mtime FROM cards').all() as DbCardRecord[];
  const dbMap = new Map(dbRecords.map((r) => [r.id, r.file_mtime]));

  const diskIds = new Set<string>();

  let added = 0;
  let updated = 0;
  let removed = 0;

  const insertStmt = db.prepare(`
    INSERT INTO cards (
      id, type, status, title, domain, stack, applies_to, task_type, error_signature,
      scope, version_range, sensitivity, supersedes, conflicts_with, source_commit, provenance,
      verified_by, verification_method, last_verified, deprecation_reason, deprecated_at, deprecated_by,
      body, created_at, updated_at, file_mtime
    ) VALUES (
      @id, @type, @status, @title, @domain, @stack, @applies_to, @task_type, @error_signature,
      @scope, @version_range, @sensitivity, @supersedes, @conflicts_with, @source_commit, @provenance,
      @verified_by, @verification_method, @last_verified, @deprecation_reason, @deprecated_at, @deprecated_by,
      @body, @created_at, @updated_at, @file_mtime
    )
  `);

  const updateStmt = db.prepare(`
    UPDATE cards SET
      type = @type, status = @status, title = @title, domain = @domain, stack = @stack,
      applies_to = @applies_to, task_type = @task_type, error_signature = @error_signature,
      scope = @scope, version_range = @version_range, sensitivity = @sensitivity, supersedes = @supersedes,
      conflicts_with = @conflicts_with, source_commit = @source_commit, provenance = @provenance,
      verified_by = @verified_by, verification_method = @verification_method, last_verified = @last_verified,
      deprecation_reason = @deprecation_reason, deprecated_at = @deprecated_at, deprecated_by = @deprecated_by,
      body = @body, updated_at = @updated_at, file_mtime = @file_mtime
    WHERE id = @id
  `);

  const deleteStmt = db.prepare('DELETE FROM cards WHERE id = @id');

  const transaction = db.transaction(() => {
    for (const filePath of files) {
      const id = path.basename(filePath, '.md');

      let stat;
      try {
        stat = fs.statSync(filePath);
      } catch (e) {
        console.error(`[reconciler] skip ${filePath}: ${(e as Error).message}`);
        continue;
      }
      const fileMtime = stat.mtime.toISOString();

      const dbMtime = dbMap.get(id);
      if (dbMtime === fileMtime) {
        diskIds.add(id);
        continue;
      }

      let parsed: matter.GrayMatterFile<string>;
      try {
        const rawContent = fs.readFileSync(filePath, 'utf-8');
        parsed = matter(rawContent);
      } catch (e) {
        console.error(`[reconciler] skip ${filePath}: ${(e as Error).message}`);
        continue;
      }

      let card;
      try {
        ({ card } = validateCardLenient(parsed.data));
      } catch (e) {
        const reason = e instanceof ValidationError ? e.message : (e as Error).message;
        console.error(`[reconciler] skip ${filePath}: ${reason}`);
        continue;
      }

      diskIds.add(id);

      const record = {
        id,
        type: card.type,
        status: card.status,
        title: card.title,
        domain: card.domain ?? null,
        stack: JSON.stringify(card.stack),
        applies_to: JSON.stringify(card.applies_to),
        task_type: card.task_type ?? null,
        error_signature: card.error_signature ?? null,
        scope: card.scope,
        version_range: card.version_range,
        sensitivity: card.sensitivity,
        supersedes: card.supersedes,
        conflicts_with: JSON.stringify(card.conflicts_with),
        source_commit: card.source_commit,
        provenance: card.provenance,
        verified_by: card.verified_by,
        verification_method: card.verification_method,
        last_verified: card.last_verified,
        deprecation_reason: card.status === 'deprecated' ? card.deprecation_reason : null,
        deprecated_at: card.status === 'deprecated' ? card.deprecated_at : null,
        deprecated_by: card.status === 'deprecated' ? card.deprecated_by : null,
        body: parsed.content,
        created_at: fileMtime,
        updated_at: fileMtime,
        file_mtime: fileMtime,
      };

      if (dbMtime === undefined) {
        insertStmt.run(record);
        added++;
      } else {
        updateStmt.run(record);
        updated++;
      }

      insertCardRelationsAndStacks(db, id, card);
    }

    for (const id of dbMap.keys()) {
      if (!diskIds.has(id)) {
        deleteStmt.run({ id });
        deleteCardRelationsAndStacks(db, id);
        removed++;
      }
    }
  });

  transaction();

  const elapsed = Date.now() - startTime;
  console.error(`Index reconciliation: +${added} added, -${removed} removed, ~${updated} updated (${elapsed}ms)`);

  foldAllEvents(db, knowledgeStorePath);
}
