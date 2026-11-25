import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/env.js';
import { triageDrafts } from '../services/triage-service.js';
import type { RelatedEvidence, TriageEntry, TriageReport } from '../services/triage-service.js';
import { buildFreshIndex } from './benchmark.js';
import { firstAddedByCard } from './doctor.js';

const NONE = 'No drafts to triage.';

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// The report states facts. A deprecated card is shown as "retired" so the output never reads as a command.
function evidenceLine(r: RelatedEvidence): string {
  const parts = [`${r.status === 'deprecated' ? 'retired' : r.status} ${r.id}`, `title ${r.titleSimilarity.toFixed(2)}`];
  if (r.isSupersedeTarget) parts.push('replaces this card');
  else if (r.facetsOverlap) parts.push('same facets');
  if (r.sameProject === true) parts.push('same project');
  else if (r.sameProject === false) parts.push('other project');
  if (r.alreadySupersededBy !== undefined) parts.push(`already replaced by ${r.alreadySupersededBy}`);
  if (r.rejectionReason !== undefined) parts.push(r.rejectionReason);
  return `    ${parts.join(' · ')}`;
}

function age(entry: TriageEntry): string {
  return `${entry.ageDays} ${entry.ageDays === 1 ? 'day' : 'days'} old`;
}

export function formatTriageReport(report: TriageReport): string {
  if (report.checked === 0) return NONE;
  const lines: string[] = [];
  if (report.withRelated.length > 0) {
    lines.push('Compare before deciding', '');
    for (const entry of report.withRelated) {
      lines.push(`  ${entry.id} · ${entry.title} (${age(entry)})`);
      for (const r of entry.related) {
        lines.push(evidenceLine(r), `      ${r.title}`);
      }
      lines.push('');
    }
  }
  if (report.withoutRelated.length > 0) {
    lines.push('No related card', '');
    for (const entry of report.withoutRelated) lines.push(`  ${entry.id} · ${entry.title} (${age(entry)})`);
  }
  return lines.join('\n').trimEnd();
}

/**
 * Read-only: builds a throwaway in-memory index from the card files (AD-2), never writes, never creates the
 * store. Returns the text (or JSON) to print.
 */
export async function runTriage(storePath: string, opts: { limit?: number; json?: boolean }): Promise<string> {
  let report: TriageReport = { checked: 0, withRelated: [], withoutRelated: [] };
  if (isDirectory(storePath)) {
    const db = await buildFreshIndex(storePath);
    try {
      const addedAt = fs.existsSync(path.join(storePath, '.git')) ? firstAddedByCard(storePath) : undefined;
      report = triageDrafts(db, { limit: opts.limit, addedAt });
    } finally {
      db.close();
    }
  }
  return opts.json ? JSON.stringify(report, null, 2) : formatTriageReport(report);
}

export const TRIAGE_USAGE = 'Usage: triage [--limit <n>] [--json]';

export function parseTriageArgs(argv: string[]): { limit?: number; json: boolean } | null {
  let limit: number | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') json = true;
    else if (a === '--limit') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 0) return null;
      limit = n;
    } else return null;
  }
  return { limit, json };
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const args = parseTriageArgs(process.argv.slice(2));
  if (args === null) {
    console.error(TRIAGE_USAGE);
    process.exit(1);
  }
  runTriage(config.knowledgeStorePath, args)
    .then((out) => {
      console.log(out);
    })
    .catch((err: unknown) => {
      console.error('[triage] failed:', err);
      process.exit(1);
    });
}
