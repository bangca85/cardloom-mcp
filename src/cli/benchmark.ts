import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import BetterSqlite3 from 'better-sqlite3';
import type Database from 'better-sqlite3';
import { parse as parseYaml } from 'yaml';
import { config } from '../config/env.js';
import { initializeSchema } from '../db/schema.js';
import { reconcileIndex } from '../services/index-reconciler.js';
import { searchCards, type SearchContext } from '../services/search-service.js';

export interface BenchmarkQuery {
  query: string;
  context?: SearchContext;
  expected: string;
}

export interface BenchmarkMiss {
  query: string;
  expected: string;
  actual_top1: string | null;
}

export interface BenchmarkReport {
  total: number;
  hits: number;
  hitRatePercent: number;
  p50Ms: number;
  p95Ms: number;
  misses: BenchmarkMiss[];
}

function isBenchmarkQuery(value: unknown): value is BenchmarkQuery {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v['query'] === 'string' && typeof v['expected'] === 'string';
}

export function parseQueriesYaml(raw: string): BenchmarkQuery[] {
  const parsed: unknown = parseYaml(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('queries.yaml must be a YAML list of {query, expected, context?}');
  }
  const invalidIndex = parsed.findIndex((item) => !isBenchmarkQuery(item));
  if (invalidIndex !== -1) {
    throw new Error(`queries.yaml entry at index ${invalidIndex} is missing required "query"/"expected" string fields`);
  }
  return parsed as BenchmarkQuery[];
}

/**
 * Builds a throwaway in-memory index straight from the card files, so the benchmark never scores
 * against whatever stale index.db happens to be on disk (AD-2: the index is derived).
 */
export async function buildFreshIndex(storePath: string): Promise<Database.Database> {
  const db = new BetterSqlite3(':memory:');
  initializeSchema(db);
  await reconcileIndex(db, storePath);
  return db;
}

/** Expected card ids that have no row in `cards` — de-duplicated, sorted. */
export function findMissingExpected(db: Database.Database, queries: BenchmarkQuery[]): string[] {
  const exists = db.prepare('SELECT 1 FROM cards WHERE id = ?');
  const missing = new Set<string>();
  for (const q of queries) {
    if (!exists.get(q.expected)) missing.add(q.expected);
  }
  return [...missing].sort();
}

export function corpusFingerprint(db: Database.Database): { cards: number; verified: number; sha256: string } {
  const rows = db
    .prepare('SELECT id, status, file_mtime FROM cards ORDER BY id')
    .all() as Array<{ id: string; status: string; file_mtime: string }>;
  const hash = createHash('sha256');
  for (const r of rows) hash.update(`${r.id}|${r.status}|${r.file_mtime}\n`);
  return {
    cards: rows.length,
    verified: rows.filter((r) => r.status === 'verified').length,
    sha256: hash.digest('hex'),
  };
}

function percentile(sortedDurations: number[], p: number): number {
  if (sortedDurations.length === 0) return 0;
  const index = Math.min(sortedDurations.length - 1, Math.ceil((p / 100) * sortedDurations.length) - 1);
  return sortedDurations[Math.max(0, index)]!;
}

/**
 * Runs every query through the SAME search-service path search_knowledge uses (AD-10) — no
 * second ranking implementation for the benchmark to drift against. Never throws on a miss;
 * a low hit rate is a measurement, not a test failure (AC3).
 */
export function runBenchmark(db: Parameters<typeof searchCards>[0], queries: BenchmarkQuery[]): BenchmarkReport {
  const durations: number[] = [];
  const misses: BenchmarkMiss[] = [];
  let hits = 0;

  for (const q of queries) {
    const start = performance.now();
    const results = searchCards(db, q.query, { context: q.context });
    durations.push(performance.now() - start);

    const top1 = results[0]?.id ?? null;
    if (top1 === q.expected) {
      hits++;
    } else {
      misses.push({ query: q.query, expected: q.expected, actual_top1: top1 });
    }
  }

  const sorted = [...durations].sort((a, b) => a - b);

  return {
    total: queries.length,
    hits,
    hitRatePercent: queries.length === 0 ? 0 : (hits / queries.length) * 100,
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    misses,
  };
}

export function formatReport(report: BenchmarkReport): string {
  const lines = [
    `[benchmark] ${report.hits}/${report.total} top-1 hits (${report.hitRatePercent.toFixed(1)}%)`,
    `[benchmark] latency p50=${report.p50Ms.toFixed(2)}ms p95=${report.p95Ms.toFixed(2)}ms`,
  ];

  if (report.misses.length > 0) {
    lines.push('[benchmark] misses:');
    for (const miss of report.misses) {
      lines.push(`  - query="${miss.query}" expected=${miss.expected} actual_top1=${miss.actual_top1 ?? '(none)'}`);
    }
  }

  return lines.join('\n');
}

/** This is a standalone CLI, not the MCP server process — stdout is free to use (AD-12 only restricts the server). */
export async function runBenchmarkCli(): Promise<void> {
  const queriesPath = path.join(config.knowledgeStorePath, 'benchmark', 'queries.yaml');

  if (!fs.existsSync(queriesPath)) {
    console.log(`[benchmark] no queries file yet at ${queriesPath}`);
    console.log('[benchmark] create it as a YAML list: [{query: "...", expected: "<card-id>", context?: {...}}] — see README.md#benchmark');
    return;
  }

  const queries = parseQueriesYaml(fs.readFileSync(queriesPath, 'utf-8'));
  const db = await buildFreshIndex(config.knowledgeStorePath);

  try {
    const missing = findMissingExpected(db, queries);
    if (missing.length > 0) {
      console.log(`[benchmark] ${missing.length} expected card id(s) are not in the store — refusing to score:`);
      for (const id of missing) console.log(`  - ${id}`);
      process.exitCode = 2;
      return;
    }

    const fp = corpusFingerprint(db);
    console.log(`[benchmark] corpus cards=${fp.cards} verified=${fp.verified} sha256=${fp.sha256}`);
    const report = runBenchmark(db, queries);
    console.log(formatReport(report));
  } finally {
    db.close();
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  runBenchmarkCli().catch((err: unknown) => {
    console.error('[benchmark] failed:', err);
    process.exit(1);
  });
}
