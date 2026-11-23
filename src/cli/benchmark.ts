import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import BetterSqlite3 from 'better-sqlite3';
import type Database from 'better-sqlite3';
import { parse as parseYaml } from 'yaml';
import { config } from '../config/env.js';
import { initializeSchema } from '../db/schema.js';
import { reconcileIndex } from '../services/index-reconciler.js';
import { searchCards, type SearchContext, type SearchFallback, type SearchRanking } from '../services/search-service.js';

export type BenchmarkKind = 'known' | 'missing' | 'project_decision' | 'cross_project';

const BENCHMARK_KINDS: readonly BenchmarkKind[] = ['known', 'missing', 'project_decision', 'cross_project'];

export interface BenchmarkQuery {
  query: string;
  /** Defaults to `known`. `missing` queries have no `expected`. */
  kind?: BenchmarkKind;
  expected?: string | string[];
  /** Card ids that must not come back as top-1 (project_decision: wrong-project answers). */
  forbidden?: string[];
  context?: SearchContext;
  /** Reporting label only (e.g. a synthetic query shape); defaults to the kind. */
  group?: string;
}

export interface BenchmarkMiss {
  query: string;
  kind: BenchmarkKind;
  expected: string;
  actual_top1: string | null;
}

/** Rates are fractions in [0, 1]; which fields are set depends on the kind. */
export interface KindReport {
  n: number;
  hit1?: number;
  mrr5?: number;
  recall5?: number;
  falseAnswerRate?: number;
  anyResultRate?: number;
  wrongProjectTop1Rate?: number;
}

export interface BenchmarkOptions {
  ranking?: SearchRanking;
  fallback?: SearchFallback;
}

export interface BenchmarkReport {
  total: number;
  /** Top-1 hits over queries that have an `expected` (every kind except `missing`). */
  hits: number;
  hitRatePercent: number;
  byKind: Partial<Record<BenchmarkKind, KindReport>>;
  /** Same metrics, split by `group` (falls back to the kind). */
  byGroup: Record<string, KindReport & { kind: BenchmarkKind }>;
  p50Ms: number;
  p95Ms: number;
  misses: BenchmarkMiss[];
}

export function queryKind(q: BenchmarkQuery): BenchmarkKind {
  return q.kind ?? 'known';
}

function expectedIds(q: BenchmarkQuery): string[] {
  if (q.expected === undefined) return [];
  return Array.isArray(q.expected) ? q.expected : [q.expected];
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string');
}

function validateEntry(item: unknown, index: number): BenchmarkQuery {
  const where = `queries.yaml entry at index ${index}`;
  if (typeof item !== 'object' || item === null) throw new Error(`${where} must be a mapping`);
  const v = item as Record<string, unknown>;
  if (typeof v['query'] !== 'string') throw new Error(`${where} is missing required "query" string`);
  const kind = v['kind'];
  if (kind !== undefined && !BENCHMARK_KINDS.includes(kind as BenchmarkKind)) {
    throw new Error(`${where} has an unknown "kind" (${String(kind)}); use one of ${BENCHMARK_KINDS.join(', ')}`);
  }
  if (kind !== 'missing' && typeof v['expected'] !== 'string' && !isStringList(v['expected'])) {
    throw new Error(`${where} is missing "expected" (a card id or a non-empty list of card ids)`);
  }
  if (v['forbidden'] !== undefined && !isStringList(v['forbidden'])) {
    throw new Error(`${where} has an invalid "forbidden" (must be a non-empty list of card ids)`);
  }
  return v as unknown as BenchmarkQuery;
}

export function parseQueriesYaml(raw: string): BenchmarkQuery[] {
  const parsed: unknown = parseYaml(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('queries.yaml must be a YAML list of {query, kind?, expected?, forbidden?, context?}');
  }
  return parsed.map((item, i) => validateEntry(item, i));
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

/** Expected and forbidden card ids that have no row in `cards` — de-duplicated, sorted. */
export function findMissingExpected(db: Database.Database, queries: BenchmarkQuery[]): string[] {
  const exists = db.prepare('SELECT 1 FROM cards WHERE id = ?');
  const missing = new Set<string>();
  for (const q of queries) {
    for (const id of [...expectedIds(q), ...(q.forbidden ?? [])]) {
      if (!exists.get(id)) missing.add(id);
    }
  }
  return [...missing].sort();
}

/**
 * Expected ids that exist but default search visibility (AD-10: verified + normal) would never
 * return — such a query can only ever miss, so the CLI warns about them.
 */
export function findInvisibleExpected(db: Database.Database, queries: BenchmarkQuery[]): string[] {
  const row = db.prepare('SELECT status, sensitivity FROM cards WHERE id = ?');
  const invisible = new Set<string>();
  for (const q of queries) {
    for (const id of expectedIds(q)) {
      const r = row.get(id) as { status: string; sensitivity: string } | undefined;
      if (r && (r.status !== 'verified' || r.sensitivity === 'restricted')) invisible.add(id);
    }
  }
  return [...invisible].sort();
}

const MISSING_QUERY_COUNT = 100;

/**
 * Deterministic query suite derived from the store itself: verbatim titles, natural-language
 * paraphrases, noisy pasted error lines, and fabricated queries that no card can answer.
 * Only verified + normal cards are used, since those are the only ones default search can return.
 */
export function syntheticQueries(db: Database.Database): BenchmarkQuery[] {
  const cards = db
    .prepare(
      "SELECT id, type, title, error_signature FROM cards WHERE status = 'verified' AND sensitivity = 'normal' ORDER BY id",
    )
    .all() as Array<{ id: string; type: string; title: string; error_signature: string | null }>;

  const queries: BenchmarkQuery[] = [];
  for (const c of cards) {
    queries.push({ query: c.title, kind: 'known', expected: c.id, group: 'title' });
    const words = c.title.split(/\s+/).filter(Boolean).slice(0, 7).join(' ');
    queries.push({
      query: `how do I fix ${words} problem in my project`,
      kind: 'known',
      expected: c.id,
      group: 'title_nl',
    });
    if (c.type === 'gotcha' && c.error_signature) {
      queries.push({
        query: `Error: ${c.error_signature} at line 42 (node:12345)`,
        kind: 'known',
        expected: c.id,
        group: 'sig_noisy',
      });
    }
  }

  const ftsHits = db.prepare('SELECT count(*) AS c FROM cards_fts WHERE cards_fts MATCH ?');
  for (let i = 0; i < MISSING_QUERY_COUNT; i++) {
    const token = `zqxv${7000 + 13 * i}`;
    const hits = (ftsHits.get(`"${token}"`) as { c: number }).c;
    if (hits > 0) {
      throw new Error(`synthetic missing token ${token} matches ${hits} card(s) in the store; it is not a valid negative`);
    }
    queries.push({ query: `${token} error`, kind: 'missing', group: 'missing' });
  }
  return queries;
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

interface Acc {
  kind: BenchmarkKind;
  n: number;
  hit1: number;
  rr5: number;
  recall5: number;
  falseAnswers: number;
  anyResult: number;
  wrongProject: number;
}

function finishAcc(a: Acc): KindReport & { kind: BenchmarkKind } {
  const r = (x: number): number => (a.n === 0 ? 0 : x / a.n);
  const base = { kind: a.kind, n: a.n };
  switch (a.kind) {
    case 'missing':
      return { ...base, falseAnswerRate: r(a.falseAnswers), anyResultRate: r(a.anyResult) };
    case 'project_decision':
      return { ...base, hit1: r(a.hit1), wrongProjectTop1Rate: r(a.wrongProject) };
    default:
      return { ...base, hit1: r(a.hit1), mrr5: r(a.rr5), recall5: r(a.recall5) };
  }
}

/**
 * Runs every query through the SAME search-service path search_knowledge uses (AD-10) — no
 * second ranking implementation for the benchmark to drift against. Never throws on a miss;
 * a low hit rate is a measurement, not a test failure (AC3). `opts` overrides ranking/fallback
 * through searchCards options only, never via env.
 */
export function runBenchmark(
  db: Parameters<typeof searchCards>[0],
  queries: BenchmarkQuery[],
  opts: BenchmarkOptions = {},
): BenchmarkReport {
  const durations: number[] = [];
  const misses: BenchmarkMiss[] = [];
  const byKindAcc = new Map<BenchmarkKind, Acc>();
  const byGroupAcc = new Map<string, Acc>();
  let hits = 0;
  let scored = 0;

  const accFor = <K>(map: Map<K, Acc>, key: K, kind: BenchmarkKind): Acc => {
    let a = map.get(key);
    if (!a) {
      a = { kind, n: 0, hit1: 0, rr5: 0, recall5: 0, falseAnswers: 0, anyResult: 0, wrongProject: 0 };
      map.set(key, a);
    }
    return a;
  };

  for (const q of queries) {
    const kind = queryKind(q);
    const start = performance.now();
    const results = searchCards(db, q.query, { context: q.context, ranking: opts.ranking, fallback: opts.fallback });
    durations.push(performance.now() - start);

    const accs = [accFor(byKindAcc, kind, kind), accFor(byGroupAcc, q.group ?? kind, kind)];
    for (const a of accs) a.n++;

    const top1 = results[0]?.id ?? null;
    const top1Item = results[0];

    if (kind === 'missing') {
      const falseAnswer = top1Item !== undefined && top1Item.match !== 'related';
      for (const a of accs) {
        if (falseAnswer) a.falseAnswers++;
        if (results.length > 0) a.anyResult++;
      }
      if (falseAnswer) misses.push({ query: q.query, kind, expected: '(no answer)', actual_top1: top1 });
      continue;
    }

    const expected = expectedIds(q);
    scored++;
    const top5 = results.slice(0, 5).map((r) => r.id);
    const firstRank = top5.findIndex((id) => expected.includes(id));
    const hit1 = top1 !== null && expected.includes(top1);
    if (hit1) hits++;
    for (const a of accs) {
      if (hit1) a.hit1++;
      if (firstRank !== -1) {
        a.rr5 += 1 / (firstRank + 1);
        a.recall5++;
      }
      if (kind === 'project_decision' && top1 !== null && (q.forbidden ?? []).includes(top1)) a.wrongProject++;
    }
    if (!hit1) misses.push({ query: q.query, kind, expected: expected.join('|'), actual_top1: top1 });
  }

  const sorted = [...durations].sort((a, b) => a - b);
  const byKind: Partial<Record<BenchmarkKind, KindReport>> = {};
  for (const [kind, a] of byKindAcc) {
    const { kind: _k, ...rest } = finishAcc(a);
    byKind[kind] = rest;
  }
  const byGroup: BenchmarkReport['byGroup'] = {};
  for (const [group, a] of byGroupAcc) byGroup[group] = finishAcc(a);

  return {
    total: queries.length,
    hits,
    hitRatePercent: scored === 0 ? 0 : (hits / scored) * 100,
    byKind,
    byGroup,
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    misses,
  };
}

const pct = (x: number | undefined): string => (x === undefined ? '-' : `${(x * 100).toFixed(1)}%`);

function describeGroup(g: KindReport & { kind: BenchmarkKind }): string {
  switch (g.kind) {
    case 'missing':
      return `falseAnswerRate=${pct(g.falseAnswerRate)} anyResultRate=${pct(g.anyResultRate)}`;
    case 'project_decision':
      return `hit@1=${pct(g.hit1)} wrongProjectTop1Rate=${pct(g.wrongProjectTop1Rate)}`;
    default:
      return `hit@1=${pct(g.hit1)} mrr@5=${(g.mrr5 ?? 0).toFixed(3)} recall@5=${pct(g.recall5)}`;
  }
}

export function formatReport(report: BenchmarkReport): string {
  const lines = [
    `[benchmark] ${report.hits}/${report.total} top-1 hits (${report.hitRatePercent.toFixed(1)}%)`,
  ];
  for (const [name, g] of Object.entries(report.byGroup)) {
    lines.push(`[benchmark] ${name} (${g.kind}, n=${g.n}): ${describeGroup(g)}`);
  }
  lines.push(`[benchmark] latency p50=${report.p50Ms.toFixed(2)}ms p95=${report.p95Ms.toFixed(2)}ms`);

  if (report.misses.length > 0) {
    lines.push('[benchmark] misses:');
    for (const miss of report.misses) {
      lines.push(`  - [${miss.kind}] query="${miss.query}" expected=${miss.expected} actual_top1=${miss.actual_top1 ?? '(none)'}`);
    }
  }

  return lines.join('\n');
}

export const MATRIX_CONFIGS: Array<{ ranking: SearchRanking; fallback: SearchFallback }> = [
  { ranking: 'baseline', fallback: 'off' },
  { ranking: 'baseline', fallback: 'tiered' },
  { ranking: 'x', fallback: 'tiered' },
  { ranking: 'y', fallback: 'tiered' },
];

/** One row per config; one column per query group, showing that group's headline metric(s). */
export function formatMatrix(rows: Array<{ label: string; report: BenchmarkReport }>): string {
  const groupNames: string[] = [];
  for (const { report } of rows) {
    for (const name of Object.keys(report.byGroup)) if (!groupNames.includes(name)) groupNames.push(name);
  }
  const cell = (report: BenchmarkReport, name: string): string => {
    const g = report.byGroup[name];
    if (!g) return '-';
    switch (g.kind) {
      case 'missing':
        return `FAR ${pct(g.falseAnswerRate)} any ${pct(g.anyResultRate)}`;
      case 'project_decision':
        return `hit@1 ${pct(g.hit1)} wrongProj ${pct(g.wrongProjectTop1Rate)}`;
      case 'cross_project':
        return `hit@1 ${pct(g.hit1)} recall@5 ${pct(g.recall5)}`;
      default:
        return `hit@1 ${pct(g.hit1)}`;
    }
  };
  const table: string[][] = [
    ['config', ...groupNames, 'p50/p95 ms'],
    ...rows.map(({ label, report }) => [
      label,
      ...groupNames.map((n) => cell(report, n)),
      `${report.p50Ms.toFixed(2)}/${report.p95Ms.toFixed(2)}`,
    ]),
  ];
  const widths = table[0]!.map((_, c) => Math.max(...table.map((r) => r[c]!.length)));
  return table.map((r) => '| ' + r.map((v, c) => v.padEnd(widths[c]!)).join(' | ') + ' |').join('\n');
}

/** This is a standalone CLI, not the MCP server process — stdout is free to use (AD-12 only restricts the server). */
export async function runBenchmarkCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const synthetic = argv.includes('--synthetic');
  const matrix = argv.includes('--matrix');
  const queriesPath = path.join(config.knowledgeStorePath, 'benchmark', 'queries.yaml');

  if (!synthetic && !fs.existsSync(queriesPath)) {
    console.log(`[benchmark] no queries file yet at ${queriesPath}`);
    console.log('[benchmark] create it as a YAML list: [{query: "...", expected: "<card-id>", kind?: ..., context?: {...}}] — see README.md#benchmark');
    return;
  }

  const db = await buildFreshIndex(config.knowledgeStorePath);

  try {
    let queries: BenchmarkQuery[];
    if (synthetic) {
      queries = syntheticQueries(db);
    } else {
      queries = parseQueriesYaml(fs.readFileSync(queriesPath, 'utf-8'));
      const missing = findMissingExpected(db, queries);
      if (missing.length > 0) {
        console.log(`[benchmark] ${missing.length} expected/forbidden card id(s) are not in the store — refusing to score:`);
        for (const id of missing) console.log(`  - ${id}`);
        process.exitCode = 2;
        return;
      }
      const invisible = findInvisibleExpected(db, queries);
      if (invisible.length > 0) {
        console.log(`[benchmark] WARNING: ${invisible.length} expected card id(s) exist but default search never returns them (not verified, or restricted):`);
        for (const id of invisible) console.log(`  - ${id}`);
      }
    }

    const fp = corpusFingerprint(db);
    console.log(`[benchmark] corpus cards=${fp.cards} verified=${fp.verified} sha256=${fp.sha256}`);
    console.log(`[benchmark] queries=${queries.length}${synthetic ? ' (synthetic)' : ''}`);

    if (matrix) {
      const rows = MATRIX_CONFIGS.map((c) => ({
        label: `${c.ranking}/${c.fallback}`,
        report: runBenchmark(db, queries, c),
      }));
      console.log(formatMatrix(rows));
    } else {
      console.log(formatReport(runBenchmark(db, queries)));
    }
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
