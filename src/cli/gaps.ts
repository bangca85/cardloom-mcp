import { config } from '../config/env.js';
import { buildGapsReport, isInsideStore, readTelemetry, type GapsReport } from '../services/telemetry-service.js';

export const GAPS_USAGE = [
  'Usage: gaps [--json]',
  '',
  '  Shows how the recorded searches ended (answered, related only, empty) and, if search text is recorded,',
  '  the questions with no direct answer. Reads telemetry.jsonl beside the index; needs no index or store.',
  '  Recording is off by default: set CARDLOOM_TELEMETRY=local (and CARDLOOM_TELEMETRY_SAMPLES=1 for the text).',
  '  --json  print the report as JSON',
].join('\n');

/** `help` is set only when `--help` / `-h` was given: the caller prints the usage and exits 0. */
export function parseGapsArgs(argv: string[]): { json: boolean; help?: true } | null {
  let json = false;
  for (const a of argv) {
    if (a === '--help' || a === '-h') return { json, help: true };
    if (a === '--json') json = true;
    else return null;
  }
  return { json };
}

const NO_TELEMETRY = 'No telemetry yet. Set CARDLOOM_TELEMETRY=local to start recording.';

export function formatGapsReport(r: GapsReport): string {
  const out = [
    `${r.total} ${r.total === 1 ? 'search' : 'searches'} since ${r.since ?? 'n/a'}`,
    `  answered: ${r.answered}`,
    `  related only: ${r.relatedOnly}`,
    `  empty: ${r.empty}`,
    '',
  ];
  if (r.topQueries.length > 0) {
    out.push('Questions with no direct answer');
    for (const q of r.topQueries) out.push(`  ${q.query} (${q.count})`);
  } else if (!r.samplesEnabled) {
    out.push('Search text is not recorded. Set CARDLOOM_TELEMETRY_SAMPLES=1 to also record the text of unanswered searches.');
  } else {
    out.push('Questions with no direct answer: none.');
  }
  return out.join('\n');
}

const INSIDE_STORE_DEFAULT =
  'Telemetry is not recorded while the index is inside the knowledge store. Set INDEX_DB_PATH or CARDLOOM_TELEMETRY_PATH outside it.';
const INSIDE_STORE_OVERRIDE =
  'Telemetry is not recorded while CARDLOOM_TELEMETRY_PATH is inside the knowledge store. Set INDEX_DB_PATH or CARDLOOM_TELEMETRY_PATH outside it.';

/**
 * Read-only: needs neither the index nor the store, and creates nothing. Returns the text (or JSON) to print.
 * With `storePath` given, a file inside the store is never read: the writer refuses that path, so there is
 * nothing to report (`--json` prints the zeroed report).
 */
export function runGaps(filePath: string, opts: { json: boolean; storePath?: string; overridden?: boolean }): string {
  const inside = opts.storePath !== undefined && isInsideStore(filePath, opts.storePath);
  if (inside && !opts.json) return opts.overridden === true ? INSIDE_STORE_OVERRIDE : INSIDE_STORE_DEFAULT;
  const report = buildGapsReport(inside ? [] : readTelemetry(filePath));
  if (opts.json) return JSON.stringify(report, null, 2);
  return report.total === 0 ? NO_TELEMETRY : formatGapsReport(report);
}

/** Reads the configured path (the launcher and `npm run gaps` share it). */
export function runGapsCommand(args: { json: boolean }): string {
  return runGaps(config.telemetryPath, {
    json: args.json,
    storePath: config.knowledgeStorePath,
    overridden: config.telemetryPathOverridden,
  });
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const args = parseGapsArgs(process.argv.slice(2));
  if (args === null) {
    console.error(GAPS_USAGE);
    process.exit(1);
  }
  if (args.help) {
    console.log(GAPS_USAGE);
    process.exit(0);
  }
  try {
    console.log(runGapsCommand(args));
  } catch (err) {
    console.error('[gaps] failed:', err);
    process.exit(1);
  }
}
