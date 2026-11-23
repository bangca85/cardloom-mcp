import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/env.js';
import { EMPTY_STORE_HINT } from '../config/messages.js';
import { buildFreshIndex, parseQueriesYaml } from './benchmark.js';

export interface DoctorReport {
  storePath: string;
  storeExists: boolean;
  isGitRepo: boolean;
  indexDbPath: string;
  cards: { draft: number; verified: number; deprecated: number };
  /** Number of entries in `benchmark/queries.yaml`; `null` when absent or unparseable. */
  benchmarkQueries: number | null;
  /** True when `benchmark/queries.yaml` exists but could not be parsed. */
  benchmarkQueriesInvalid?: boolean;
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Read-only health check: never creates directories or files and never touches the real index.db
 * (counts come from a throwaway in-memory index built from the card files, AD-2).
 */
export async function runDoctor(storePath: string, indexDbPath: string): Promise<DoctorReport> {
  const storeExists = isDirectory(storePath);
  const report: DoctorReport = {
    storePath,
    storeExists,
    isGitRepo: storeExists && fs.existsSync(path.join(storePath, '.git')),
    indexDbPath,
    cards: { draft: 0, verified: 0, deprecated: 0 },
    benchmarkQueries: null,
  };
  if (!storeExists) return report;

  const db = await buildFreshIndex(storePath);
  try {
    const rows = db.prepare('SELECT status, COUNT(*) AS c FROM cards GROUP BY status').all() as Array<{
      status: string;
      c: number;
    }>;
    for (const row of rows) {
      if (row.status === 'draft' || row.status === 'verified' || row.status === 'deprecated') {
        report.cards[row.status] = row.c;
      }
    }
  } finally {
    db.close();
  }

  const queriesPath = path.join(storePath, 'benchmark', 'queries.yaml');
  if (fs.existsSync(queriesPath)) {
    try {
      report.benchmarkQueries = parseQueriesYaml(fs.readFileSync(queriesPath, 'utf-8')).length;
    } catch {
      report.benchmarkQueriesInvalid = true;
    }
  }
  return report;
}

export function formatDoctorReport(r: DoctorReport): string {
  const lines = [
    `Knowledge store: ${r.storePath} (${r.storeExists ? 'found' : 'not found'})`,
    `Git repository:  ${r.isGitRepo ? 'yes' : 'no'}`,
    `Index database:  ${r.indexDbPath}`,
    'Cards:',
    `  draft:      ${r.cards.draft}`,
    `  verified:   ${r.cards.verified}`,
    `  deprecated: ${r.cards.deprecated}`,
    `Benchmark queries: ${r.benchmarkQueries === null ? 'none' : r.benchmarkQueries}`,
  ];
  if (r.benchmarkQueriesInvalid) {
    lines.push('Warning: benchmark/queries.yaml is invalid (could not be parsed).');
  }
  if (r.cards.verified === 0) lines.push(EMPTY_STORE_HINT);
  return lines.join('\n');
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  runDoctor(config.knowledgeStorePath, config.indexDbPath)
    .then((report) => {
      console.log(formatDoctorReport(report));
    })
    .catch((err: unknown) => {
      console.error('[doctor] failed:', err);
      process.exit(1);
    });
}
