import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type Database from 'better-sqlite3';
import { buildFreshIndex } from '../src/cli/benchmark.js';
import { AnthropicRunner, MAX_TOOL_CALLS } from './anthropic-runner.js';
import { scoreAnswer, summarize, type ModeSummary } from './score.js';
import { loadTasks } from './tasks.js';
import {
  buildPrompts,
  createToolBox,
  listEligibleCards,
  loadRepoContext,
  loadToolSpecs,
  renderEligibleCards,
  type RepoContext,
} from './toolbox.js';
import { EVAL_MODES, type AgentRunner, type EvalMode, type EvalResult, type EvalTask, type ToolSpec } from './types.js';

const EVAL_DIR = import.meta.dirname;
export const DEFAULT_OUT_DIR = path.join(EVAL_DIR, 'results');
const TASKS_FILE = path.join(EVAL_DIR, 'tasks', 'tasks.yaml');
const STORE_DIR = path.join(EVAL_DIR, 'fixtures', 'store');
const REPOS_DIR = path.join(EVAL_DIR, 'fixtures', 'repos');

export const USAGE = `Usage: npm run eval -- [options]

Maintainer-run agent-level eval. Without --confirm-spend it only prints the plan (a dry run) and exits 0.

  --confirm-spend       actually call the model (needs ANTHROPIC_API_KEY and EVAL_MODEL); this costs money
  --runs N              runs per (task, mode), default 3
  --modes a,b,c         any of ${EVAL_MODES.join(', ')} (default all)
  --compact-pair        run search_then_get twice: get_card full vs compact: true (replaces --modes)
  --out <dir>           results directory (default eval/results, git-ignored)
  -h, --help`;

export interface EvalArgs {
  runs: number;
  modes: EvalMode[];
  compactPair: boolean;
  confirmSpend: boolean;
  outDir: string;
  help: boolean;
}

export function parseArgs(argv: string[]): EvalArgs | { error: string } {
  const args: EvalArgs = { runs: 3, modes: [...EVAL_MODES], compactPair: false, confirmSpend: false, outDir: DEFAULT_OUT_DIR, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = (): string | undefined => argv[++i];
    switch (a) {
      case '--confirm-spend':
        args.confirmSpend = true;
        break;
      case '--compact-pair':
        args.compactPair = true;
        break;
      case '-h':
      case '--help':
        args.help = true;
        break;
      case '--runs': {
        const v = value();
        const n = v === undefined || !/^\d+$/.test(v) ? 0 : Number(v);
        if (n < 1) return { error: '--runs needs a positive integer' };
        args.runs = n;
        break;
      }
      case '--modes': {
        const v = value();
        if (v === undefined || v === '') return { error: '--modes needs a comma-separated list' };
        const modes = v.split(',').map((m) => m.trim());
        const bad = modes.find((m) => !(EVAL_MODES as readonly string[]).includes(m));
        if (bad !== undefined) return { error: `unknown mode "${bad}" (expected ${EVAL_MODES.join(', ')})` };
        args.modes = modes as EvalMode[];
        break;
      }
      case '--out': {
        const v = value();
        if (v === undefined || v === '') return { error: '--out needs a directory' };
        args.outDir = path.resolve(v);
        break;
      }
      default:
        return { error: `unknown argument ${a}` };
    }
  }
  return args;
}

export function planLine(tasks: number, modes: number, runs: number): string {
  return `${tasks} tasks × ${modes} modes × ${runs} runs = ${tasks * modes * runs} model runs`;
}

interface Unit {
  label: string;
  mode: EvalMode;
  variant?: 'full' | 'compact';
}

function unitsFor(args: EvalArgs): Unit[] {
  if (args.compactPair) {
    return [
      { label: 'full', mode: 'search_then_get', variant: 'full' },
      { label: 'compact', mode: 'search_then_get', variant: 'compact' },
    ];
  }
  return args.modes.map((mode) => ({ label: mode, mode }));
}

export interface SummaryRow {
  label: string;
  mode: EvalMode;
  summary: ModeSummary;
  errors: number;
  /** Runs that failed the rubric (errored runs excluded). */
  rubricFailures: number;
  refetchCalls: number;
  refetchChars: number;
}

export interface EvalReport {
  schema: 1;
  startedAt: string;
  model: string;
  tasks: number;
  runsPerCell: number;
  compactPair: boolean;
  summaries: SummaryRow[];
  results: EvalResult[];
}

export interface RunEvalInput {
  tasks: EvalTask[];
  db: Database.Database;
  specs: ToolSpec[];
  runner: AgentRunner;
  model: string;
  runs: number;
  units: Unit[];
  contextFor: (repo: string) => RepoContext;
  log?: (line: string) => void;
}

export async function runEval(input: RunEvalInput): Promise<Pick<EvalReport, 'results' | 'summaries'>> {
  const results: EvalResult[] = [];
  const total = input.tasks.length * input.units.length * input.runs;
  for (const task of input.tasks) {
    const context = input.contextFor(task.repo);
    for (const unit of input.units) {
      for (let run = 1; run <= input.runs; run++) {
        const tools = createToolBox(input.db, { mode: unit.mode, context, specs: input.specs, getCardDefault: unit.variant === 'compact' ? 'compact' : 'full' });
        const cards = unit.mode === 'read_all' ? renderEligibleCards(input.db, listEligibleCards(input.db, context)) : undefined;
        const { system, prompt } = buildPrompts({ task, mode: unit.mode, context, cards, getCardDefault: unit.variant === 'compact' ? 'compact' : 'full' });
        const base = { taskId: task.id, mode: unit.mode, ...(unit.variant && { variant: unit.variant }), run };
        try {
          const out = await input.runner.run({ task, mode: unit.mode, model: input.model, tools, prompt, system });
          const score = scoreAnswer(task, out.answer);
          const stats = tools.stats();
          results.push({
            ...base,
            pass: score.pass,
            failed: score.failed,
            answer: out.answer,
            tokens: out.tokens,
            toolCalls: out.toolCalls,
            latencyMs: out.latencyMs,
            ...(out.capped && { capped: true }),
            seenMatches: stats.seenMatches,
            seenCards: stats.seenCards,
            refetchCalls: stats.refetchCalls,
            refetchChars: stats.refetchChars,
          });
        } catch (err) {
          results.push({ ...base, pass: false, failed: [], answer: '', tokens: 0, toolCalls: 0, latencyMs: 0, error: err instanceof Error ? err.message : String(err) });
        }
        input.log?.(`[eval] ${results.length}/${total} ${task.id} ${unit.label} run ${run}: ${results[results.length - 1]!.error !== undefined ? 'ERROR' : results[results.length - 1]!.pass ? 'pass' : 'fail'}`);
      }
    }
  }

  const summaries: SummaryRow[] = input.units.map((unit) => {
    const mine = results.filter((r) => r.mode === unit.mode && r.variant === unit.variant);
    const ok = mine.filter((r) => r.error === undefined);
    return {
      label: unit.label,
      mode: unit.mode,
      summary: summarize(mine).byMode[unit.mode],
      errors: mine.length - ok.length,
      rubricFailures: ok.filter((r) => !r.pass).length,
      refetchCalls: ok.reduce((n, r) => n + (r.refetchCalls ?? 0), 0),
      refetchChars: ok.reduce((n, r) => n + (r.refetchChars ?? 0), 0),
    };
  });
  return { results, summaries };
}

export function formatSummaries(rows: SummaryRow[], taskCount: number, runs: number, compactPair: boolean): string {
  const header = ['variant/mode', 'runs', 'pass rate', 'mean tokens', 'p95 latency ms', 'wrongOnRelatedOnly', 'errors', ...(compactPair ? ['rubric failures', 're-fetch calls', 're-fetch chars'] : [])];
  const lines = rows.map((r) => [
    r.label,
    String(r.summary.runs),
    `${(r.summary.passRate * 100).toFixed(1)}%`,
    r.summary.meanTokens.toFixed(0),
    String(r.summary.p95LatencyMs),
    String(r.summary.wrongOnRelatedOnly),
    String(r.errors),
    ...(compactPair ? [String(r.rubricFailures), String(r.refetchCalls), String(r.refetchChars)] : []),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i]!.length)));
  const fmt = (cells: string[]): string => cells.map((c, i) => c.padEnd(widths[i]!)).join('  ').trimEnd();
  return [
    fmt(header),
    ...lines.map(fmt),
    '',
    `${taskCount} tasks, ${runs} runs per task and mode. A seed set this small is a smoke test: no number above is a claim (see eval/README.md).`,
  ].join('\n');
}

export interface MainDeps {
  log?: (line: string) => void;
  error?: (line: string) => void;
  /** Tests inject a runner; a real run builds an `AnthropicRunner` from the environment. */
  runner?: AgentRunner;
  now?: () => Date;
}

export async function main(argv: string[], env: Record<string, string | undefined>, deps: MainDeps = {}): Promise<number> {
  const log = deps.log ?? ((s: string) => console.log(s));
  const error = deps.error ?? ((s: string) => console.error(s));

  const parsed = parseArgs(argv);
  if ('error' in parsed) {
    error(`[eval] ${parsed.error}\n${USAGE}`);
    return 1;
  }
  if (parsed.help) {
    log(USAGE);
    return 0;
  }

  const tasks = loadTasks(TASKS_FILE);
  const units = unitsFor(parsed);
  log(`[eval] plan: ${planLine(tasks.length, units.length, parsed.runs)}`);
  log(
    `[eval] WARNING: this is a paid run. Each model run is up to ${MAX_TOOL_CALLS + 1} API requests (one per tool-use turn, ${MAX_TOOL_CALLS} tool calls at most) and read_all sends every eligible card in each prompt. ` +
      'No price is assumed here: look up the current pricing of your model and multiply it by the runs above before you spend.',
  );

  if (!parsed.confirmSpend) {
    log('[eval] dry run: nothing was called. Add --confirm-spend (with ANTHROPIC_API_KEY and EVAL_MODEL set) to run it for real.');
    return 0;
  }

  const apiKey = env.ANTHROPIC_API_KEY;
  const model = env.EVAL_MODEL;
  if (deps.runner === undefined) {
    const missing = [apiKey ? '' : 'ANTHROPIC_API_KEY', model ? '' : 'EVAL_MODEL'].filter(Boolean);
    if (missing.length > 0) {
      error(`[eval] --confirm-spend needs ${missing.join(' and ')} in the environment. Nothing was run.`);
      return 1;
    }
  }

  const startedAt = (deps.now ?? (() => new Date()))();
  const db = await buildFreshIndex(STORE_DIR);
  try {
    const specs = await loadToolSpecs(db, STORE_DIR);
    const contexts = new Map<string, RepoContext>();
    const contextFor = (repo: string): RepoContext => {
      let c = contexts.get(repo);
      if (c === undefined) {
        c = loadRepoContext(repo, REPOS_DIR);
        contexts.set(repo, c);
      }
      return c;
    };
    const runner = deps.runner ?? new AnthropicRunner({ apiKey: apiKey! });
    const usedModel = model ?? 'stub-model';
    const { results, summaries } = await runEval({ tasks, db, specs, runner, model: usedModel, runs: parsed.runs, units, contextFor, log });

    const report: EvalReport = {
      schema: 1,
      startedAt: startedAt.toISOString(),
      model: usedModel,
      tasks: tasks.length,
      runsPerCell: parsed.runs,
      compactPair: parsed.compactPair,
      summaries,
      results,
    };
    fs.mkdirSync(parsed.outDir, { recursive: true });
    const file = path.join(parsed.outDir, `${startedAt.toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    log(formatSummaries(summaries, tasks.length, parsed.runs, parsed.compactPair));
    log(`[eval] results written to ${file}`);
    return 0;
  } finally {
    db.close();
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main(process.argv.slice(2), process.env).then(
    (code) => process.exit(code),
    (err) => {
      console.error('[eval] failed:', err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
