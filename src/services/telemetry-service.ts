import fs from 'node:fs';
import path from 'node:path';
import { config, type TelemetryMode } from '../config/env.js';
import { scanForSecrets } from './secret-scanner.js';

/**
 * Opt-in local search telemetry (AD-3/AD-4 amendment 2026-11-25, owner decision D3).
 *
 * `telemetry.jsonl` lives beside the index. It is not business state: it is written outside the MutationPipeline,
 * never committed, and never read by trust, flags or ranking. It records how a search ended, never which cards
 * were returned, the context, or the repo.
 */

export type SearchOutcome = 'answered' | 'related_only' | 'empty';

export interface TelemetryEntry {
  v: 1;
  at: string;
  tool: 'search_knowledge';
  result_count: number;
  outcome: SearchOutcome;
  latency_ms: number;
  query?: string;
}

export interface RecordSearchInput {
  resultCount: number;
  outcome: SearchOutcome;
  latencyMs: number;
  query?: string;
}

export interface RecordSearchOptions {
  now?: Date;
  path?: string;
  mode?: TelemetryMode;
  samples?: boolean;
}

const DEFAULT_RETENTION_DAYS = 90;
const DAY_MS = 86_400_000;
const QUERY_MAX_CHARS = 200;
const TOP_QUERIES = 10;
const OUTCOMES: readonly SearchOutcome[] = ['answered', 'related_only', 'empty'];

// Per process: the UTC day each file was last pruned, and whether a write failure was already reported.
const lastPruneDay = new Map<string, string>();
let warned = false;

/** Test hook: forget the once-per-day prune stamps and the once-per-process warning. */
export function resetTelemetryState(): void {
  lastPruneDay.clear();
  warned = false;
}

/** stderr only (AD-12), and at most once per process: a broken disk must not spam one line per search. */
function warnOnce(err: unknown): void {
  if (warned) return;
  warned = true;
  const reason = err instanceof Error ? err.message : String(err);
  console.error(`[telemetry] cannot write ${reason}; further telemetry errors are not reported`);
}

export function classifyOutcome(found: Array<{ match: string }>): SearchOutcome {
  if (found.length === 0) return 'empty';
  return found.every((item) => item.match === 'related') ? 'related_only' : 'answered';
}

/**
 * The text to store for an unanswered search, or undefined. Scans both the full text and the cut text, so a
 * secret just past the cut still keeps the whole query out. The scan does not remove customer names or
 * internal terms; that is why samples are a separate opt-in.
 */
function sampleText(query: string | undefined): string | undefined {
  if (query === undefined || query.trim() === '') return undefined;
  const cut = query.slice(0, QUERY_MAX_CHARS);
  try {
    scanForSecrets(query);
    scanForSecrets(cut);
  } catch {
    return undefined;
  }
  return cut;
}

/**
 * Appends one entry. No-op unless the mode is `local`; never throws and never blocks beyond one synchronous
 * append (a single `appendFileSync` of one whole line ending in `\n`, so two server processes sharing the file
 * cannot interleave inside a line).
 */
export function recordSearch(input: RecordSearchInput, opts: RecordSearchOptions = {}): void {
  try {
    if ((opts.mode ?? config.telemetryMode) !== 'local') return;
    const file = opts.path ?? config.telemetryPath;
    const now = opts.now ?? new Date();
    fs.mkdirSync(path.dirname(file), { recursive: true });

    const day = now.toISOString().slice(0, 10);
    if (lastPruneDay.get(file) !== day) {
      lastPruneDay.set(file, day);
      pruneTelemetry(file, now);
    }

    const samples = opts.samples ?? config.telemetrySamples;
    const query = samples && input.outcome !== 'answered' ? sampleText(input.query) : undefined;
    const entry: TelemetryEntry = {
      v: 1,
      at: now.toISOString(),
      tool: 'search_knowledge',
      result_count: input.resultCount,
      outcome: input.outcome,
      latency_ms: input.latencyMs,
      ...(query !== undefined && { query }),
    };
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
  } catch (err) {
    warnOnce(err);
  }
}

function isEntry(value: unknown): value is TelemetryEntry {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    c['v'] === 1 &&
    typeof c['at'] === 'string' &&
    !Number.isNaN(Date.parse(c['at'])) &&
    c['tool'] === 'search_knowledge' &&
    typeof c['result_count'] === 'number' &&
    typeof c['outcome'] === 'string' &&
    OUTCOMES.includes(c['outcome'] as SearchOutcome) &&
    typeof c['latency_ms'] === 'number' &&
    (c['query'] === undefined || typeof c['query'] === 'string')
  );
}

function parseLine(line: string): TelemetryEntry | null {
  try {
    const value: unknown = JSON.parse(line);
    return isEntry(value) ? value : null;
  } catch {
    return null;
  }
}

/** Valid entries in file order; malformed lines are skipped. A missing file is no telemetry. */
export function readTelemetry(filePath: string): TelemetryEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: TelemetryEntry[] = [];
  for (const line of raw.split('\n')) {
    if (line === '') continue;
    const entry = parseLine(line);
    if (entry !== null) out.push(entry);
  }
  return out;
}

/**
 * Drops entries older than `retentionDays` and malformed lines. The kept lines go to a temp file in the same
 * directory that is then renamed over the original, so a reader sees the old or the new file, never half of one.
 * A prune racing another process's append may lose that one line: acceptable for telemetry, and it can never
 * corrupt a line. Never throws; a missing file is a no-op.
 */
export function pruneTelemetry(filePath: string, now: Date, retentionDays: number = DEFAULT_RETENTION_DAYS): void {
  const tmp = `${filePath}.${process.pid}.tmp`;
  try {
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    const cutoff = now.getTime() - retentionDays * DAY_MS;
    const kept: string[] = [];
    let dropped = false;
    for (const line of raw.split('\n')) {
      if (line === '') continue;
      const entry = parseLine(line);
      if (entry !== null && Date.parse(entry.at) >= cutoff) kept.push(line);
      else dropped = true;
    }
    if (!dropped) return;
    fs.writeFileSync(tmp, kept.map((l) => `${l}\n`).join(''));
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // Nothing more to do for a telemetry temp file.
    }
    warnOnce(err);
  }
}

export interface GapsReport {
  total: number;
  answered: number;
  relatedOnly: number;
  empty: number;
  since: string | null;
  topQueries: Array<{ query: string; count: number }>;
  samplesEnabled: boolean;
}

const normaliseQuery = (q: string): string => q.toLowerCase().trim().replace(/\s+/g, ' ');

export function buildGapsReport(entries: TelemetryEntry[]): GapsReport {
  let answered = 0;
  let relatedOnly = 0;
  let empty = 0;
  let since: string | null = null;
  let samplesEnabled = false;
  const counts = new Map<string, number>();
  for (const e of entries) {
    if (e.outcome === 'answered') answered++;
    else if (e.outcome === 'related_only') relatedOnly++;
    else empty++;
    if (since === null || Date.parse(e.at) < Date.parse(since)) since = e.at;
    if (e.query !== undefined) {
      samplesEnabled = true;
      if (e.outcome !== 'answered') {
        const q = normaliseQuery(e.query);
        if (q !== '') counts.set(q, (counts.get(q) ?? 0) + 1);
      }
    }
  }
  const topQueries = [...counts.entries()]
    .map(([query, count]) => ({ query, count }))
    .sort((a, b) => b.count - a.count || (a.query < b.query ? -1 : a.query > b.query ? 1 : 0))
    .slice(0, TOP_QUERIES);
  return { total: entries.length, answered, relatedOnly, empty, since, topQueries, samplesEnabled };
}
