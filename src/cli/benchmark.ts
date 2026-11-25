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
import { handleSearchKnowledge } from '../tools/search-knowledge.js';
import { estimateToolJsonTokens } from '../utils/token-estimate.js';

export type BenchmarkKind =
  | 'known'
  | 'missing'
  | 'project_decision'
  | 'cross_project'
  | 'superseded'
  | 'stale'
  | 'drift'
  | 'wrong_scope';

const BENCHMARK_KINDS: readonly BenchmarkKind[] = [
  'known',
  'missing',
  'project_decision',
  'cross_project',
  'superseded',
  'stale',
  'drift',
  'wrong_scope',
];

export interface BenchmarkQuery {
  query: string;
  /** Defaults to `known`. `missing` queries have no `expected`. */
  kind?: BenchmarkKind;
  expected?: string | string[];
  /** Card ids that must not come back as top-1 (project_decision: wrong-project answers; wrong_scope: wrong-scope answers). */
  forbidden?: string[];
  /** superseded only: the card `expected` replaced; it must not show up in the default-visibility top 5. */
  replaced?: string;
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
  /** Share of queries with `expected` in the top 10. Only set for runs with `limit` >= 10. */
  recall10?: number;
  falseAnswerRate?: number;
  anyResultRate?: number;
  wrongProjectTop1Rate?: number;
  /** superseded: share of queries where `replaced` is anywhere in the top 5, labelled or not (visibility). */
  replacedVisibleRate?: number;
  /** stale / drift: share of queries with `expected` in the top 5 (retrieval). */
  retrievedRate?: number;
  /** stale / drift: among the retrieved, share carrying flags.stale / flags.drift (flagging). */
  flagAccuracy?: number;
  /** wrong_scope: share whose top-1 is a `forbidden` id, flagged or not (ranking). */
  wrongScopeTop1Rate?: number;
  /** wrong_scope: among those wrong top-1s, share flagged drift (diagnostic only). */
  wrongTop1FlaggedRate?: number;
}

export interface BenchmarkOptions {
  ranking?: SearchRanking;
  fallback?: SearchFallback;
  /** Clock for the stale flag and trust decay; defaults to the real time. */
  now?: Date;
  /** `search_knowledge`'s `limit`; when unset the search-service default applies and `recall10` is not reported. */
  limit?: number;
}

export interface BenchmarkReport {
  total: number;
  /** Queries that have an `expected` (every kind except `missing`): the denominator for `hits`. */
  scored: number;
  /** Top-1 hits over the `scored` queries. */
  hits: number;
  hitRatePercent: number;
  byKind: Partial<Record<BenchmarkKind, KindReport>>;
  /** Same metrics, split by `group` (falls back to the kind). */
  byGroup: Record<string, KindReport & { kind: BenchmarkKind }>;
  p50Ms: number;
  p95Ms: number;
  /**
   * Estimated tokens of `handleSearchKnowledge`'s serialised JSON per query (chars / 4), not a tokenizer count.
   * Measured with the same ranking, fallback, limit and clock (`opts.now`) as the scored run, so the JSON sized
   * is the result that was scored (flags such as `stale` depend on the clock).
   */
  estimatedResponseTokens: { mean: number; p95: number };
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
  if (kind === 'missing') {
    if (v['expected'] !== undefined) {
      throw new Error(`${where} is kind "missing" and must not have "expected" (no card should answer it)`);
    }
  } else if (typeof v['expected'] !== 'string' && !isStringList(v['expected'])) {
    throw new Error(`${where} is missing "expected" (a card id or a non-empty list of card ids)`);
  }
  if (kind === 'project_decision') {
    if (!isStringList(v['forbidden'])) {
      throw new Error(
        `${where} is kind "project_decision" and requires a non-empty "forbidden" list (otherwise wrongProjectTop1Rate is always 0%)`,
      );
    }
  } else if (kind === 'wrong_scope') {
    if (!isStringList(v['forbidden'])) {
      throw new Error(
        `${where} is kind "wrong_scope" and requires a non-empty "forbidden" list (otherwise wrongScopeTop1Rate is always 0%)`,
      );
    }
  } else if (v['forbidden'] !== undefined) {
    throw new Error(`${where} has "forbidden", which only applies to kind "project_decision" or "wrong_scope"`);
  }
  if (kind === 'superseded') {
    if (typeof v['replaced'] !== 'string' || v['replaced'] === '') {
      throw new Error(`${where} is kind "superseded" and requires "replaced" (the card id that "expected" replaced)`);
    }
  } else if (v['replaced'] !== undefined) {
    throw new Error(`${where} has "replaced", which only applies to kind "superseded"`);
  }
  if (kind === 'drift') {
    const versions = (v['context'] as { versions?: unknown } | undefined)?.versions;
    if (typeof versions !== 'object' || versions === null || Object.keys(versions).length === 0) {
      throw new Error(`${where} is kind "drift" and requires "context.versions" (otherwise no card can be flagged drift)`);
    }
  }
  return v as unknown as BenchmarkQuery;
}

export function parseQueriesYaml(raw: string): BenchmarkQuery[] {
  const parsed: unknown = parseYaml(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('queries.yaml must be a YAML list of {query, kind?, expected?, forbidden?, replaced?, context?}');
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

/** Expected, forbidden and replaced card ids that have no row in `cards` — de-duplicated, sorted. */
export function findMissingExpected(db: Database.Database, queries: BenchmarkQuery[]): string[] {
  const exists = db.prepare('SELECT 1 FROM cards WHERE id = ?');
  const missing = new Set<string>();
  for (const q of queries) {
    for (const id of [...expectedIds(q), ...(q.forbidden ?? []), ...(q.replaced ? [q.replaced] : [])]) {
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
  recall10: number;
  falseAnswers: number;
  anyResult: number;
  wrongProject: number;
  replacedVisible: number;
  retrieved: number;
  flagged: number;
  wrongScope: number;
  wrongFlagged: number;
}

function newAcc(kind: BenchmarkKind): Acc {
  return {
    kind,
    n: 0,
    hit1: 0,
    rr5: 0,
    recall5: 0,
    recall10: 0,
    falseAnswers: 0,
    anyResult: 0,
    wrongProject: 0,
    replacedVisible: 0,
    retrieved: 0,
    flagged: 0,
    wrongScope: 0,
    wrongFlagged: 0,
  };
}

/** Compile-time exhaustiveness check for the per-kind switches: a new BenchmarkKind fails the build here. */
function assertNever(value: never): never {
  throw new Error(`unhandled benchmark kind: ${String(value)}`);
}

/** A conditional rate; 0 when its condition never occurred (the unconditional rate beside it shows that). */
const ratio = (part: number, whole: number): number => (whole === 0 ? 0 : part / whole);

/** `withRecall10`: the run's limit was >= 10, so top-10 recall is meaningful (known and cross_project only). */
function finishAcc(a: Acc, withRecall10: boolean): KindReport & { kind: BenchmarkKind } {
  const r = (x: number): number => (a.n === 0 ? 0 : x / a.n);
  const base = { kind: a.kind, n: a.n };
  switch (a.kind) {
    case 'missing':
      return { ...base, falseAnswerRate: r(a.falseAnswers), anyResultRate: r(a.anyResult) };
    case 'project_decision':
      return { ...base, hit1: r(a.hit1), wrongProjectTop1Rate: r(a.wrongProject) };
    case 'superseded':
      return { ...base, hit1: r(a.hit1), mrr5: r(a.rr5), replacedVisibleRate: r(a.replacedVisible) };
    case 'stale':
    case 'drift':
      return { ...base, retrievedRate: r(a.retrieved), flagAccuracy: ratio(a.flagged, a.retrieved) };
    case 'wrong_scope':
      return {
        ...base,
        hit1: r(a.hit1),
        wrongScopeTop1Rate: r(a.wrongScope),
        wrongTop1FlaggedRate: ratio(a.wrongFlagged, a.wrongScope),
      };
    case 'known':
    case 'cross_project':
      return {
        ...base,
        hit1: r(a.hit1),
        mrr5: r(a.rr5),
        recall5: r(a.recall5),
        ...(withRecall10 && { recall10: r(a.recall10) }),
      };
    default:
      return assertNever(a.kind);
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
  const responseTokens: number[] = [];
  const withRecall10 = opts.limit !== undefined && opts.limit >= 10;
  const misses: BenchmarkMiss[] = [];
  const byKindAcc = new Map<BenchmarkKind, Acc>();
  const byGroupAcc = new Map<string, Acc>();
  let hits = 0;
  let scored = 0;

  const accFor = <K>(map: Map<K, Acc>, key: K, kind: BenchmarkKind): Acc => {
    let a = map.get(key);
    if (!a) {
      a = newAcc(kind);
      map.set(key, a);
    }
    return a;
  };

  for (const q of queries) {
    const kind = queryKind(q);
    const start = performance.now();
    const results = searchCards(
      db,
      q.query,
      { context: q.context, ranking: opts.ranking, fallback: opts.fallback, limit: opts.limit },
      opts.now,
    );
    durations.push(performance.now() - start);
    // The size the agent actually receives: the tool's own serialised JSON, not the searchCards items.
    const toolResponse = handleSearchKnowledge(
      db,
      { query: q.query, context: q.context, limit: opts.limit },
      { ranking: opts.ranking, fallback: opts.fallback, now: opts.now },
    );
    responseTokens.push(estimateToolJsonTokens(toolResponse.content[0]!.text));

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
    const inTop10 = results.slice(0, 10).some((r) => expected.includes(r.id));
    const hit1 = top1 !== null && expected.includes(top1);
    const replacedVisible = kind === 'superseded' && q.replaced !== undefined && top5.includes(q.replaced);
    const wrongScope = kind === 'wrong_scope' && top1 !== null && (q.forbidden ?? []).includes(top1);
    const retrievedItem = firstRank === -1 ? undefined : results[firstRank];
    if (hit1) hits++;
    for (const a of accs) {
      if (hit1) a.hit1++;
      if (firstRank !== -1) {
        a.rr5 += 1 / (firstRank + 1);
        a.recall5++;
      }
      if (inTop10) a.recall10++;
      if (kind === 'project_decision' && top1 !== null && (q.forbidden ?? []).includes(top1)) a.wrongProject++;
      if (replacedVisible) a.replacedVisible++;
      if (wrongScope) {
        a.wrongScope++;
        if (top1Item?.flags.drift) a.wrongFlagged++;
      }
      if ((kind === 'stale' || kind === 'drift') && retrievedItem) {
        a.retrieved++;
        if (retrievedItem.flags[kind]) a.flagged++;
      }
    }
    if (!hit1) misses.push({ query: q.query, kind, expected: expected.join('|'), actual_top1: top1 });
  }

  const sorted = [...durations].sort((a, b) => a - b);
  const byKind: Partial<Record<BenchmarkKind, KindReport>> = {};
  for (const [kind, a] of byKindAcc) {
    const { kind: _k, ...rest } = finishAcc(a, withRecall10);
    byKind[kind] = rest;
  }
  const byGroup: BenchmarkReport['byGroup'] = {};
  for (const [group, a] of byGroupAcc) byGroup[group] = finishAcc(a, withRecall10);

  return {
    total: queries.length,
    scored,
    hits,
    hitRatePercent: scored === 0 ? 0 : (hits / scored) * 100,
    byKind,
    byGroup,
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    estimatedResponseTokens: {
      mean: responseTokens.length === 0 ? 0 : responseTokens.reduce((sum, t) => sum + t, 0) / responseTokens.length,
      p95: percentile([...responseTokens].sort((x, y) => x - y), 95),
    },
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
    case 'superseded':
      return `visible=${pct(g.replacedVisibleRate)} hit@1=${pct(g.hit1)} mrr@5=${(g.mrr5 ?? 0).toFixed(3)}`;
    case 'stale':
    case 'drift':
      return `retrieved=${pct(g.retrievedRate)} flag acc=${pct(g.flagAccuracy)}`;
    case 'wrong_scope':
      return `hit@1=${pct(g.hit1)} wrong@1=${pct(g.wrongScopeTop1Rate)} flagged@1=${pct(g.wrongTop1FlaggedRate)}`;
    case 'known':
    case 'cross_project':
      return `hit@1=${pct(g.hit1)} mrr@5=${(g.mrr5 ?? 0).toFixed(3)} recall@5=${pct(g.recall5)}${
        g.recall10 === undefined ? '' : ` recall@10=${pct(g.recall10)}`
      }`;
    default:
      return assertNever(g.kind);
  }
}

export function formatReport(report: BenchmarkReport): string {
  const lines = [
    `[benchmark] ${report.hits}/${report.scored} top-1 hits (${report.hitRatePercent.toFixed(1)}%) across ${report.scored} scored of ${report.total} queries`,
  ];
  for (const [name, g] of Object.entries(report.byGroup)) {
    lines.push(`[benchmark] ${name} (${g.kind}, n=${g.n}): ${describeGroup(g)}`);
  }
  lines.push(`[benchmark] latency p50=${report.p50Ms.toFixed(2)}ms p95=${report.p95Ms.toFixed(2)}ms`);
  lines.push(
    `[benchmark] estimated response tokens mean=${report.estimatedResponseTokens.mean.toFixed(0)} p95=${report.estimatedResponseTokens.p95} (tool JSON chars / 4)`,
  );

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
      case 'superseded':
        return `visible ${pct(g.replacedVisibleRate)} hit@1 ${pct(g.hit1)}`;
      case 'stale':
      case 'drift':
        return `retrieved ${pct(g.retrievedRate)} flag acc ${pct(g.flagAccuracy)}`;
      case 'wrong_scope':
        return `hit@1 ${pct(g.hit1)} wrong@1 ${pct(g.wrongScopeTop1Rate)}`;
      case 'known':
        return `hit@1 ${pct(g.hit1)}`;
      default:
        return assertNever(g.kind);
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
  return renderTable(table);
}

function renderTable(table: string[][]): string {
  const widths = table[0]!.map((_, c) => Math.max(...table.map((r) => r[c]!.length)));
  return table.map((r) => '| ' + r.map((v, c) => v.padEnd(widths[c]!)).join(' | ') + ' |').join('\n');
}

export const COMPARE_LIMIT_SMALL = 5;
export const COMPARE_LIMIT_LARGE = 10;
export const COMPARE_RANKINGS: readonly SearchRanking[] = ['baseline', 'x', 'y'];

export interface LimitComparison {
  at5: BenchmarkReport;
  at10: BenchmarkReport;
}

/**
 * Two real runs, one per limit, never "run 10 and cut to 5": with the tiered fallback `limit` decides whether the
 * OR tier runs at all (`andRows.length >= limit`), so the same query can return different sets at 5 and at 10.
 */
export function compareLimits(
  db: Parameters<typeof searchCards>[0],
  queries: BenchmarkQuery[],
  opts: Omit<BenchmarkOptions, 'limit'> = {},
): LimitComparison {
  return {
    at5: runBenchmark(db, queries, { ...opts, limit: COMPARE_LIMIT_SMALL }),
    at10: runBenchmark(db, queries, { ...opts, limit: COMPARE_LIMIT_LARGE }),
  };
}

export function compareLimitsByRanking(
  db: Parameters<typeof searchCards>[0],
  queries: BenchmarkQuery[],
  opts: Omit<BenchmarkOptions, 'limit' | 'ranking'> = {},
): Record<'baseline' | 'x' | 'y', LimitComparison> {
  // The OR tier is what `limit` switches on or off; with SEARCH_FALLBACK=off in the environment there would be
  // nothing to compare, so the tiered fallback is pinned here (an explicit `opts.fallback` still wins).
  const pinned = { fallback: 'tiered' as const, ...opts };
  return {
    baseline: compareLimits(db, queries, { ...pinned, ranking: 'baseline' }),
    x: compareLimits(db, queries, { ...pinned, ranking: 'x' }),
    y: compareLimits(db, queries, { ...pinned, ranking: 'y' }),
  };
}

/** The metric that matters for a kind besides recall; `-` for kinds whose headline is already in a column. */
function kindMetric(kind: BenchmarkKind, g: KindReport): string {
  switch (kind) {
    case 'missing':
      return `false answer ${pct(g.falseAnswerRate)}`;
    case 'project_decision':
      return `wrongProj ${pct(g.wrongProjectTop1Rate)}`;
    case 'superseded':
      return `visible ${pct(g.replacedVisibleRate)}`;
    case 'stale':
    case 'drift':
      return `retrieved ${pct(g.retrievedRate)} flag acc ${pct(g.flagAccuracy)}`;
    case 'wrong_scope':
      return `wrong@1 ${pct(g.wrongScopeTop1Rate)}`;
    case 'known':
    case 'cross_project':
      return '-';
    default:
      return assertNever(kind);
  }
}

/** One table per ranking: recall per kind at limit 5 and limit 10, then the estimated response size of both runs. */
export function formatLimitComparison(byRanking: Record<string, LimitComparison>): string {
  const blocks: string[] = [];
  for (const [ranking, { at5, at10 }] of Object.entries(byRanking)) {
    const table: string[][] = [
      [
        'kind',
        'n',
        'recall@5 (limit 5)',
        'recall@5 (limit 10)',
        'recall@10 (limit 10)',
        'hit@1 (limit 5)',
        'hit@1 (limit 10)',
        'kind metric (limit 5 / limit 10)',
      ],
    ];
    for (const [kind, k5] of Object.entries(at5.byKind)) {
      const k10 = at10.byKind[kind as BenchmarkKind];
      table.push([
        kind,
        String(k5.n),
        pct(k5.recall5),
        pct(k10?.recall5),
        pct(k10?.recall10),
        pct(k5.hit1),
        pct(k10?.hit1),
        `${kindMetric(kind as BenchmarkKind, k5)} / ${k10 ? kindMetric(kind as BenchmarkKind, k10) : '-'}`,
      ]);
    }
    const tokens = (r: BenchmarkReport): string =>
      `mean=${r.estimatedResponseTokens.mean.toFixed(0)} p95=${r.estimatedResponseTokens.p95}`;
    const lines = [`[benchmark] ranking ${ranking}`, renderTable(table)];
    lines.push(
      `[benchmark] estimated response tokens (tool JSON chars / 4): limit 5 ${tokens(at5)}; limit 10 ${tokens(at10)}`,
    );
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n');
}

function parseLimitFlag(argv: string[]): number | undefined {
  const at = argv.indexOf('--limit');
  if (at === -1) return undefined;
  const raw = argv[at + 1];
  if (raw === undefined || !/^[1-9]\d*$/.test(raw)) {
    throw new Error(`--limit needs a positive integer, got ${raw === undefined ? 'nothing' : `"${raw}"`}`);
  }
  return Number(raw);
}

/** This is a standalone CLI, not the MCP server process — stdout is free to use (AD-12 only restricts the server). */
export async function runBenchmarkCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const synthetic = argv.includes('--synthetic');
  const matrix = argv.includes('--matrix');
  const compare = argv.includes('--compare-limits');
  const limit = parseLimitFlag(argv);
  if (compare && limit !== undefined) {
    throw new Error('--compare-limits runs limit 5 and limit 10 itself; do not combine it with --limit');
  }
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

    if (compare) {
      console.log(formatLimitComparison(compareLimitsByRanking(db, queries)));
    } else if (matrix) {
      const rows = MATRIX_CONFIGS.map((c) => ({
        label: `${c.ranking}/${c.fallback}`,
        report: runBenchmark(db, queries, { ...c, limit }),
      }));
      console.log(formatMatrix(rows));
    } else {
      console.log(formatReport(runBenchmark(db, queries, { limit })));
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
