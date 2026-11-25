import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main, parseArgs, planLine, DEFAULT_OUT_DIR } from '../../eval/run-eval.js';
import { StubRunner } from '../../eval/stub-runner.js';
import { AnthropicRunner } from '../../eval/anthropic-runner.js';
import type { EvalReport } from '../../eval/run-eval.js';
import type { AgentRunner, RunInput } from '../../eval/types.js';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cardloom-eval-'));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, log: (s: string) => out.push(s), error: (s: string) => err.push(s) };
}

describe('parseArgs', () => {
  it('defaults: 3 runs, all modes, no spend, default out dir', () => {
    const a = parseArgs([]);
    expect(a).toMatchObject({ runs: 3, modes: ['top5', 'search_then_get', 'read_all'], compactPair: false, confirmSpend: false, outDir: DEFAULT_OUT_DIR });
  });
  it('parses flags', () => {
    const a = parseArgs(['--runs', '5', '--modes', 'top5,read_all', '--compact-pair', '--confirm-spend', '--out', '/x/y']);
    expect(a).toMatchObject({ runs: 5, modes: ['top5', 'read_all'], compactPair: true, confirmSpend: true, outDir: '/x/y' });
  });
  it('rejects bad input with a message', () => {
    expect(parseArgs(['--runs', '0'])).toEqual({ error: expect.stringContaining('--runs') });
    expect(parseArgs(['--runs', 'x'])).toEqual({ error: expect.stringContaining('--runs') });
    expect(parseArgs(['--modes', 'top5,bogus'])).toEqual({ error: expect.stringContaining('bogus') });
    expect(parseArgs(['--wat'])).toEqual({ error: expect.stringContaining('--wat') });
    expect(parseArgs(['--out'])).toEqual({ error: expect.stringContaining('--out') });
  });
  it('writes results under eval/results by default, and git ignores it', () => {
    expect(DEFAULT_OUT_DIR.endsWith(path.join('eval', 'results'))).toBe(true);
    expect(fs.readFileSync(path.resolve(import.meta.dirname, '../../.gitignore'), 'utf-8')).toMatch(/^eval\/results\/?$/m);
  });
});

describe('planLine', () => {
  it('states tasks x modes x runs = N model runs', () => {
    expect(planLine(8, 3, 3)).toBe('8 tasks × 3 modes × 3 runs = 72 model runs');
  });
});

describe('dry run (the default)', () => {
  it('prints the plan and the no-price cost warning, exits 0, writes nothing, without --confirm-spend', async () => {
    const io = capture();
    const out = path.join(tmp, 'results');
    const code = await main(['--out', out], {}, io);
    expect(code).toBe(0);
    const text = io.out.join('\n');
    expect(text).toContain('8 tasks × 3 modes × 3 runs = 72 model runs');
    expect(text).toMatch(/no price is assumed/i);
    expect(text).toContain('--confirm-spend');
    expect(fs.existsSync(out)).toBe(false);
  });

  it('stays a dry run with a key and model but no --confirm-spend, and never calls the runner', async () => {
    const io = capture();
    const runner: AgentRunner = { run: () => Promise.reject(new Error('must not run')) };
    const code = await main(['--runs', '1'], { ANTHROPIC_API_KEY: 'k', EVAL_MODEL: 'm' }, { ...io, runner });
    expect(code).toBe(0);
    expect(io.out.join('\n')).toContain('8 tasks × 3 modes × 1 runs = 24 model runs');
  });

  it('the compact pair plans two variants of search_then_get', async () => {
    const io = capture();
    expect(await main(['--compact-pair'], {}, io)).toBe(0);
    expect(io.out.join('\n')).toContain('8 tasks × 2 modes × 3 runs = 48 model runs');
  });

  it('honours --modes and --runs in the plan', async () => {
    const io = capture();
    await main(['--modes', 'top5', '--runs', '2'], {}, io);
    expect(io.out.join('\n')).toContain('8 tasks × 1 modes × 2 runs = 16 model runs');
  });
});

describe('--confirm-spend preconditions', () => {
  it('exits 1 with a clear message when ANTHROPIC_API_KEY is missing', async () => {
    const io = capture();
    const code = await main(['--confirm-spend', '--out', path.join(tmp, 'r')], { EVAL_MODEL: 'm' }, io);
    expect(code).toBe(1);
    expect(io.err.join('\n')).toContain('ANTHROPIC_API_KEY');
    expect(fs.existsSync(path.join(tmp, 'r'))).toBe(false);
  });
  it('exits 1 with a clear message when EVAL_MODEL is missing', async () => {
    const io = capture();
    const code = await main(['--confirm-spend'], { ANTHROPIC_API_KEY: 'k' }, io);
    expect(code).toBe(1);
    expect(io.err.join('\n')).toContain('EVAL_MODEL');
  });
  it('exits 1 on invalid arguments', async () => {
    const io = capture();
    expect(await main(['--runs', 'abc'], {}, io)).toBe(1);
    expect(io.err.join('\n')).toContain('--runs');
  });
});

describe('StubRunner end to end', () => {
  const env = { ANTHROPIC_API_KEY: 'unused-in-tests', EVAL_MODEL: 'stub-model' };

  it('runs every task in all three modes, writes a results file under the temp dir and summarises by mode', async () => {
    const io = capture();
    const out = path.join(tmp, 'results');
    const runner = new StubRunner({ defaultAnswer: 'no direct answer; amount_minor cursor' });
    const code = await main(['--confirm-spend', '--runs', '2', '--out', out], env, { ...io, runner });
    expect(code).toBe(0);

    const files = fs.readdirSync(out);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}T[\d-]+Z?\.json$/);
    const report = JSON.parse(fs.readFileSync(path.join(out, files[0]!), 'utf-8')) as EvalReport;
    expect(report.results).toHaveLength(8 * 3 * 2);
    expect(report.model).toBe('stub-model');
    expect(report.tasks).toBe(8);
    expect(report.summaries.map((s) => s.label)).toEqual(['top5', 'search_then_get', 'read_all']);
    for (const s of report.summaries) expect(s.summary.runs).toBe(16);
    expect(JSON.stringify(report)).not.toContain('unused-in-tests'); // the key never reaches the file
    expect(io.out.join('\n')).toMatch(/pass rate/i);
  });

  it('gives each mode the right tool box and prompt', async () => {
    const seen: RunInput[] = [];
    const rejections: string[] = [];
    const runner = new StubRunner({
      respond: (input) => {
        seen.push(input);
        if (input.mode === 'top5') {
          try {
            input.tools.call('get_card', { id: 'x' });
          } catch (e) {
            rejections.push((e as Error).name);
          }
        }
        return 'ok';
      },
    });
    const code = await main(['--confirm-spend', '--runs', '1', '--out', path.join(tmp, 'r')], env, { ...capture(), runner });
    expect(code).toBe(0);

    const top5 = seen.filter((s) => s.mode === 'top5');
    expect(top5).toHaveLength(8);
    expect(rejections).toEqual(Array(8).fill('ToolNotAllowedError'));
    for (const s of top5) expect(s.tools.specs.map((t) => t.name)).toEqual(['search_knowledge']);

    const stg = seen.filter((s) => s.mode === 'search_then_get');
    for (const s of stg) expect(s.tools.specs.map((t) => t.name).sort()).toEqual(['get_card', 'search_knowledge']);

    const readAll = seen.filter((s) => s.mode === 'read_all');
    expect(readAll).toHaveLength(8);
    for (const s of readAll) expect(s.tools.specs).toEqual([]);
    const notifyRun = readAll.find((s) => s.task.id === 'notify-shutdown')!;
    expect(notifyRun.prompt).toContain('"id":"pattern-queue-consumer-drain-on-sigterm"');
    expect(notifyRun.prompt).toContain('"id":"decision-notify-dedupe-window-ten-minutes"');
    expect(notifyRun.prompt).not.toContain('decision-notify-dedupe-window-one-day'); // draft
    expect(notifyRun.prompt).not.toContain('gotcha-ledger-entry-out-of-order'); // other project
    expect((notifyRun.prompt.match(/"id":"/g) ?? []).length).toBe(4);
  });

  it('records tool-use stats and related-only evidence from the tool box, and scores answers', async () => {
    const runner = new StubRunner({
      respond: (input) => {
        if (input.task.id === 'notify-tls-rotation-related-only' && input.mode === 'top5') {
          input.tools.call('search_knowledge', { query: 'rotate TLS certificates notify-worker' });
          return 'Rotate it with a second active key.'; // wrong: leans on the related card
        }
        return 'nothing useful';
      },
    });
    const out = path.join(tmp, 'r');
    await main(['--confirm-spend', '--runs', '1', '--modes', 'top5', '--out', out], env, { ...capture(), runner });
    const report = JSON.parse(fs.readFileSync(path.join(out, fs.readdirSync(out)[0]!), 'utf-8')) as EvalReport;
    const wrong = report.results.find((r) => r.taskId === 'notify-tls-rotation-related-only')!;
    expect(wrong.pass).toBe(false);
    expect(wrong.seenMatches).toEqual(expect.arrayContaining(['related']));
    expect(wrong.seenMatches!.every((m) => m === 'related')).toBe(true);
    expect(wrong.toolCalls).toBe(1);
    expect(report.summaries[0]!.summary.wrongOnRelatedOnly).toBe(1);
  });

  it('records a runner failure as an errored run, not a pass or a fail, and exits 1 when every run failed', async () => {
    const runner = new StubRunner({
      respond: () => {
        throw new Error('API 500');
      },
    });
    const io = capture();
    const out = path.join(tmp, 'r');
    expect(await main(['--confirm-spend', '--runs', '1', '--modes', 'top5', '--out', out], env, { ...io, runner })).toBe(1);
    expect(io.err.join('\n')).toMatch(/every one of the 8 runs ended in an error/);
    // the results file is still written
    const report = JSON.parse(fs.readFileSync(path.join(out, fs.readdirSync(out)[0]!), 'utf-8')) as EvalReport;
    expect(report.results.every((r) => r.error === 'API 500')).toBe(true);
    expect(report.summaries[0]!.summary).toMatchObject({ runs: 0 });
    expect(report.summaries[0]!.errors).toBe(8);
  });
});

describe('spend safety with the real runner (injected fetch)', () => {
  const env = { ANTHROPIC_API_KEY: 'sk-test', EVAL_MODEL: 'test-model' };
  const apiJson = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });
  const answer = (): Response => apiJson({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 5, output_tokens: 5 } });
  const err = (status: number): Response => apiJson({ type: 'error', error: { type: 'x', message: `status ${status}` } }, status);

  function run(responder: (n: number) => Response) {
    let requests = 0;
    const fetchFn = (async () => responder(++requests)) as unknown as typeof fetch;
    const runner = new AnthropicRunner({ apiKey: 'sk-test', fetch: fetchFn });
    return { runner, requests: () => requests };
  }

  it.each([401, 403, 404])('aborts the whole run on the first HTTP %i: one request, exit 1, results file written', async (status) => {
    const io = capture();
    const out = path.join(tmp, 'r');
    const { runner, requests } = run(() => err(status));
    const code = await main(['--confirm-spend', '--runs', '3', '--out', out], env, { ...io, runner });
    expect(code).toBe(1);
    expect(requests()).toBe(1);
    const message = io.err.join('\n');
    expect(message).toContain(String(status));
    expect(message).toContain('ANTHROPIC_API_KEY');
    expect(message).toContain('EVAL_MODEL');
    expect(message).not.toContain('sk-test');
    const report = JSON.parse(fs.readFileSync(path.join(out, fs.readdirSync(out)[0]!), 'utf-8')) as EvalReport;
    expect(report.aborted).toMatchObject({ status });
    expect(report.results).toHaveLength(1);
  });

  it('exits 1 when every run of the matrix ended in a (non-fatal) error, and still writes the file', async () => {
    const io = capture();
    const out = path.join(tmp, 'r');
    const { runner, requests } = run(() => err(500));
    expect(await main(['--confirm-spend', '--runs', '1', '--modes', 'top5', '--out', out], env, { ...io, runner })).toBe(1);
    expect(requests()).toBe(8); // a 500 is not fatal: every task was still tried
    expect(fs.readdirSync(out)).toHaveLength(1);
  });

  it('exits 0 for a mixed matrix: some runs errored, some answered', async () => {
    const io = capture();
    const out = path.join(tmp, 'r');
    const { runner } = run((n) => (n === 1 ? err(500) : answer()));
    expect(await main(['--confirm-spend', '--runs', '1', '--modes', 'top5', '--out', out], env, { ...io, runner })).toBe(0);
    const report = JSON.parse(fs.readFileSync(path.join(out, fs.readdirSync(out)[0]!), 'utf-8')) as EvalReport;
    expect(report.summaries[0]!.errors).toBe(1);
    expect(report.summaries[0]!.summary.runs).toBe(7);
    expect(report.aborted).toBeUndefined();
  });
});

describe('--compact-pair', () => {
  const env = { ANTHROPIC_API_KEY: 'unused', EVAL_MODEL: 'stub-model' };

  it('produces two summaries, full and compact, and counts re-fetches and rubric failures per variant', async () => {
    // A stub agent that fetches the required cards, re-fetching the full card only when the compact body was cut
    // and then trusts what it read: it can only mention statement_timeout if it saw it.
    const runner = new StubRunner({
      respond: (input) => {
        let text = '';
        for (const id of input.task.required_cards) {
          let r = input.tools.call('get_card', { id });
          if (JSON.parse(r.text).card?.truncated === true && input.task.id !== 'ledger-month-end-lock') {
            r = input.tools.call('get_card', { id, compact: false });
          }
          text += r.text;
        }
        return text;
      },
    });
    const out = path.join(tmp, 'r');
    const code = await main(['--confirm-spend', '--runs', '1', '--compact-pair', '--out', out], env, { ...capture(), runner });
    expect(code).toBe(0);
    const report = JSON.parse(fs.readFileSync(path.join(out, fs.readdirSync(out)[0]!), 'utf-8')) as EvalReport;

    expect(report.compactPair).toBe(true);
    expect(report.summaries.map((s) => s.label)).toEqual(['full', 'compact']);
    const [full, compact] = report.summaries as [EvalReport['summaries'][number], EvalReport['summaries'][number]];
    expect(full.mode).toBe('search_then_get');
    expect(compact.mode).toBe('search_then_get');
    expect(full.summary.runs).toBe(8);
    expect(compact.summary.runs).toBe(8);
    // the exception sits beyond 600 chars: only the compact variant can miss it
    const failedIn = (label: string) => report.results.filter((r) => r.variant === label && !r.pass && r.taskId === 'ledger-month-end-lock').length;
    expect(failedIn('full')).toBe(0);
    expect(failedIn('compact')).toBe(1);
    expect(compact.rubricFailures).toBeGreaterThan(full.rubricFailures);
    expect(full.refetchCalls).toBe(0);
    expect(compact.refetchCalls).toBe(0); // other tasks' bodies are under 600 chars, so nothing was cut
    expect(typeof compact.refetchChars).toBe('number');
  });
});

describe('fixtures are committed', () => {
  const root = path.resolve(import.meta.dirname, '../..');
  const git = (args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const inOwnWorkTree = ((): boolean => {
    try {
      return fs.realpathSync(git(['rev-parse', '--show-toplevel'])) === fs.realpathSync(root);
    } catch {
      return false; // not a git work tree (a tarball, an export): nothing to check
    }
  })();

  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

  it.skipIf(!inOwnWorkTree)('every file under eval/fixtures and eval/tasks is tracked by git, so a fresh clone has it (a .gitignore match would hide it)', () => {
    const files = [...walk(path.join(root, 'eval/fixtures')), ...walk(path.join(root, 'eval/tasks'))].map((f) => path.relative(root, f));
    expect(files.filter((f) => f.endsWith('repo-context.yaml')).length).toBe(2);
    for (const f of files) {
      expect(() => execFileSync('git', ['ls-files', '--error-unmatch', '--', f], { cwd: root, stdio: 'ignore' }), `${f} is not tracked (ignored by .gitignore?)`).not.toThrow();
    }
  });

  it('keeps the fixture contexts under a name .gitignore does not match', () => {
    expect(fs.existsSync(path.join(root, 'eval/fixtures/repos/ledger-api/repo-context.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'eval/fixtures/repos/notify-worker/repo-context.yaml'))).toBe(true);
  });
});

describe('packaging', () => {
  const root = path.resolve(import.meta.dirname, '../..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8')) as {
    files: string[];
    scripts: Record<string, string>;
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };

  it('never ships eval/ (package.json files is an allowlist without it)', () => {
    expect(pkg.files.some((f) => f === 'eval' || f.startsWith('eval/') || f.startsWith('tests'))).toBe(false);
    expect(pkg.files).not.toContain('tsconfig.eval.json');
  });

  it('has an eval script run through tsx and a typecheck script for eval/', () => {
    expect(pkg.scripts.eval).toMatch(/tsx .*eval\/run-eval\.ts/);
    expect(pkg.scripts['typecheck:eval']).toContain('tsconfig.eval.json');
  });

  it('adds no Anthropic SDK dependency', () => {
    const all = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(all.filter((d) => d.includes('anthropic'))).toEqual([]);
  });
});
