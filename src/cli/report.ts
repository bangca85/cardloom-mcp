import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/env.js';
import { buildReport } from '../services/report-service.js';
import type { UsageReport } from '../services/report-service.js';
import { buildFreshIndex } from './benchmark.js';
import { emptyReview } from '../types/review-stats.js';
import { computeReview, firstAddedByCard } from './doctor.js';

const DEFAULT_DAYS = 7;
/** About 100 years; a larger window cannot be turned into a date (`toISOString` throws a RangeError). */
export const MAX_DAYS = 36_500;

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

function section(title: string, lines: string[]): string[] {
  return ['', title, ...(lines.length > 0 ? lines.map((l) => `  ${l}`) : ['  none'])];
}

export function formatReport(r: UsageReport): string {
  const out: string[] = [];
  const total = r.confirmed + r.refuted + r.neutral;
  if (total === 0) {
    out.push(`No activity in the last ${plural(r.days, 'day', 'days')}.`);
    // Without activity the usage lists are empty by definition (stale cards still matter, so they stay).
  } else {
    out.push(`Last ${plural(r.days, 'day', 'days')}: ${r.confirmed} confirmed · ${r.refuted} refuted · ${r.neutral} neutral`);
    out.push(...section('Cards that helped most', r.topConfirmed.map((c) => `${c.id} · ${c.title} (${c.count})`)));
    out.push(...section('Cards that need a look', r.newlyNeedsReview));
  }
  out.push(...section('Cards going stale within 30 days', r.staleWithin30Days));
  const v = r.review;
  const age = v.oldestDraftDays === null ? '' : ` (oldest ${plural(v.oldestDraftDays, 'day', 'days')})`;
  out.push('', `Drafts waiting: ${v.pendingDrafts}${age}`);
  return out.join('\n');
}

/**
 * Read-only: builds a throwaway in-memory index from the card files and event log (AD-2, AD-4), never writes,
 * never creates the store. Returns the text (or JSON) to print.
 */
export async function runReport(storePath: string, opts: { days: number; json?: boolean; now?: Date }): Promise<string> {
  const now = opts.now ?? new Date();
  let report: UsageReport = {
    days: opts.days,
    confirmed: 0,
    refuted: 0,
    neutral: 0,
    topConfirmed: [],
    newlyNeedsReview: [],
    staleWithin30Days: [],
    review: emptyReview(),
  };
  if (isDirectory(storePath)) {
    const db = await buildFreshIndex(storePath);
    try {
      const added = fs.existsSync(path.join(storePath, '.git')) ? firstAddedByCard(storePath) : new Map<string, number>();
      report = buildReport(db, { days: opts.days, now, review: computeReview(db, now, added) });
    } finally {
      db.close();
    }
  }
  return opts.json ? JSON.stringify(report, null, 2) : formatReport(report);
}

export const REPORT_USAGE = 'Usage: report [--days <n>] [--json]   (n: 1 to 36500)';

/** `help` is set only when `--help` / `-h` was given: the caller prints the usage and exits 0. */
export function parseReportArgs(argv: string[]): { days: number; json: boolean; help?: true } | null {
  let days = DEFAULT_DAYS;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') return { days, json, help: true };
    if (a === '--json') json = true;
    else if (a === '--days') {
      const raw = argv[++i];
      const n = raw === undefined || !/^\d+$/.test(raw) ? NaN : Number(raw);
      if (!Number.isSafeInteger(n) || n < 1 || n > MAX_DAYS) return null;
      days = n;
    } else return null;
  }
  return { days, json };
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const args = parseReportArgs(process.argv.slice(2));
  if (args === null) {
    console.error(REPORT_USAGE);
    process.exit(1);
  }
  if (args.help) {
    console.log(REPORT_USAGE);
    process.exit(0);
  }
  runReport(config.knowledgeStorePath, args)
    .then((out) => {
      console.log(out);
    })
    .catch((err: unknown) => {
      console.error('[report] failed:', err);
      process.exit(1);
    });
}
