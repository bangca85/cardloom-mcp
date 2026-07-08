import type Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MutationPipeline } from './mutation-pipeline.js';
import { config } from '../config/env.js';

export type UsageOutcome = 'confirmed' | 'refuted' | 'neutral';

export interface UsageEvent {
  v: 1;
  card: string;
  outcome: UsageOutcome;
  at: string;
  repo?: string;
}

export const USAGE_OUTCOMES: UsageOutcome[] = ['confirmed', 'refuted', 'neutral'];

function sanitizeMachineId(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return cleaned || 'unknown';
}

export function resolveMachineId(): string {
  return sanitizeMachineId(config.machineId ?? os.hostname());
}

function isUsageEvent(value: unknown): value is UsageEvent {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate['v'] === 1 &&
    typeof candidate['card'] === 'string' &&
    candidate['card'].length > 0 &&
    typeof candidate['outcome'] === 'string' &&
    USAGE_OUTCOMES.includes(candidate['outcome'] as UsageOutcome) &&
    typeof candidate['at'] === 'string' &&
    (candidate['repo'] === undefined || typeof candidate['repo'] === 'string')
  );
}

const stmtCache = new WeakMap<Database.Database, any>();

/**
 * The ONE fold function — materializes a single usage event into the `counters` table.
 * Called both right after append (inside the mutation pipeline) and during full-fold
 * (startup reconcile / rebuild-index). Never re-derive counter math anywhere else (AD-4).
 */
export function foldEvent(db: Database.Database, event: UsageEvent): void {
  const successInc = event.outcome === 'confirmed' ? 1 : 0;
  const failureInc = event.outcome === 'refuted' ? 1 : 0;

  let stmt = stmtCache.get(db);
  if (!stmt) {
    stmt = db.prepare(
      `
      INSERT INTO counters (card_id, usage, success, failure)
      VALUES (@card_id, 1, @success_inc, @failure_inc)
      ON CONFLICT(card_id) DO UPDATE SET
        usage = usage + 1,
        success = success + @success_inc,
        failure = failure + @failure_inc
      `,
    );
    stmtCache.set(db, stmt);
  }

  stmt.run({ card_id: event.card, success_inc: successInc, failure_inc: failureInc });
}

export interface AppendUsageEventInput {
  card: string;
  outcome: UsageOutcome;
  repo?: string;
}

export interface AppendUsageEventResult {
  git_committed: boolean;
  git_error?: string;
}

export async function appendUsageEvent(
  db: Database.Database,
  storePath: string,
  input: AppendUsageEventInput,
): Promise<AppendUsageEventResult> {
  const machineId = resolveMachineId();
  const eventsDir = path.join(storePath, 'events');
  const filePath = path.join(eventsDir, `${machineId}.jsonl`);

  const event: UsageEvent = {
    v: 1,
    card: input.card,
    outcome: input.outcome,
    at: new Date().toISOString(),
    ...(input.repo !== undefined && { repo: input.repo }),
  };

  const pipeline = new MutationPipeline(db, storePath);

  const outcome = await pipeline.execute<void>({
    writeFiles: () => {
      fs.mkdirSync(eventsDir, { recursive: true });
      fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`);
      return { result: undefined };
    },
    filesToCommit: [`events/${machineId}.jsonl`],
    commitMessage: `knowledge: usage ${input.card}`,
    updateIndex: (idxDb) => {
      foldEvent(idxDb, event);
    },
  });

  return { git_committed: outcome.gitCommitted, git_error: outcome.gitError };
}

export function foldAllEvents(db: Database.Database, storePath: string): void {
  const eventsDir = path.join(storePath, 'events');
  if (!fs.existsSync(eventsDir)) {
    const txn = db.transaction(() => {
      db.exec('DELETE FROM counters');
    });
    txn();
    return;
  }

  const files = fs.readdirSync(eventsDir).filter((f) => f.endsWith('.jsonl'));
  const events: UsageEvent[] = [];

  for (const file of files) {
    const filePath = path.join(eventsDir, file);
    let content = '';
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
      console.error(`[event-log] Failed to read ${file}: ${(err as Error).message}`);
      continue;
    }
    const lines = content.split('\n');

    for (const line of lines) {
      if (line.trim() === '') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (err) {
        console.error(`[event-log] skip malformed line in ${file}: ${(err as Error).message}`);
        continue;
      }

      if (!isUsageEvent(parsed)) {
        console.error(`[event-log] skip malformed line in ${file}: does not match UsageEvent shape`);
        continue;
      }

      events.push(parsed);
    }
  }

  const txn = db.transaction(() => {
    db.exec('DELETE FROM counters');
    for (const event of events) {
      foldEvent(db, event);
    }
  });

  txn();
}
