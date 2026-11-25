import { config } from '../config/env.js';
import { buildGapsReport, readTelemetry, type GapsReport } from '../services/telemetry-service.js';

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

/** Read-only: needs neither the index nor the store, and creates nothing. Returns the text (or JSON) to print. */
export function runGaps(filePath: string, opts: { json: boolean }): string {
  const report = buildGapsReport(readTelemetry(filePath));
  if (opts.json) return JSON.stringify(report, null, 2);
  return report.total === 0 ? NO_TELEMETRY : formatGapsReport(report);
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
    console.log(runGaps(config.telemetryPath, args));
  } catch (err) {
    console.error('[gaps] failed:', err);
    process.exit(1);
  }
}
