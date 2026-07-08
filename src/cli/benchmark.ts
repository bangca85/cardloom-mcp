import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { config } from '../config/env.js';
import { getDatabase, closeDatabase } from '../db/database.js';
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
  const db = getDatabase(config.indexDbPath);

  try {
    const report = runBenchmark(db, queries);
    console.log(formatReport(report));
  } finally {
    closeDatabase();
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  runBenchmarkCli().catch((err: unknown) => {
    console.error('[benchmark] failed:', err);
    process.exit(1);
  });
}
