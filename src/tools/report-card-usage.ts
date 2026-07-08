import type Database from 'better-sqlite3';
import { appendUsageEvent, USAGE_OUTCOMES, type UsageOutcome } from '../services/event-log-service.js';
import { NotFoundError, ValidationError } from '../types/errors.js';

export interface ReportCardUsageArgs {
  id: string;
  outcome: string;
  repo?: string;
}

interface CountersRow {
  usage: number;
  success: number;
  failure: number;
}

export async function handleReportCardUsage(db: Database.Database, storePath: string, args: ReportCardUsageArgs) {
  // outcome is intentionally z.string() at the tool boundary (not z.enum) so an invalid value
  // reaches this handler and maps to our own validation_error contract (AD-7) instead of the
  // SDK's generic InvalidParams protocol error.
  if (!USAGE_OUTCOMES.includes(args.outcome as UsageOutcome)) {
    throw new ValidationError([
      { field: 'outcome', message: `must be one of: ${USAGE_OUTCOMES.join(', ')}` },
    ]);
  }

  const existing = db.prepare('SELECT id FROM cards WHERE id = ?').get(args.id);
  if (!existing) {
    throw new NotFoundError(args.id);
  }

  const result = await appendUsageEvent(db, storePath, {
    card: args.id,
    outcome: args.outcome as UsageOutcome,
    ...(args.repo !== undefined && { repo: args.repo }),
  });

  const counters = db.prepare('SELECT usage, success, failure FROM counters WHERE card_id = ?').get(args.id) as
    | CountersRow
    | undefined;

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          card: args.id,
          outcome: args.outcome,
          counters: counters ?? { usage: 0, success: 0, failure: 0 },
          git_committed: result.git_committed,
          git_error: result.git_error,
        }),
      },
    ],
  };
}
