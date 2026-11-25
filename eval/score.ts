import { EVAL_MODES, type EvalMode, type EvalResult, type EvalTask } from './types.js';

export function scoreAnswer(task: EvalTask, answer: string): { pass: boolean; failed: string[] } {
  const haystack = answer.toLowerCase();
  const failed: string[] = [];
  for (const item of task.rubric) {
    for (const s of item.must_include ?? []) {
      if (!haystack.includes(s.toLowerCase())) failed.push(`must_include: ${s}`);
    }
    for (const s of item.must_not_include ?? []) {
      if (haystack.includes(s.toLowerCase())) failed.push(`must_not_include: ${s}`);
    }
  }
  return { pass: failed.length === 0, failed };
}

/** Nearest-rank 95th percentile: the ceil(0.95 * n)-th smallest value; 0 for no values. */
export function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(1, Math.ceil(0.95 * sorted.length)) - 1]!;
}

export interface ModeSummary {
  runs: number;
  passRate: number;
  meanTokens: number;
  p95LatencyMs: number;
  /** Failed runs whose only seen search matches were `related`. */
  wrongOnRelatedOnly: number;
  /** Runs the runner threw on; they are not part of the other numbers. */
  errors: number;
}

const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

export function summarize(results: EvalResult[]): { byMode: Record<EvalMode, ModeSummary> } {
  const byMode = {} as Record<EvalMode, ModeSummary>;
  for (const mode of EVAL_MODES) {
    const ofMode = results.filter((r) => r.mode === mode);
    const ok = ofMode.filter((r) => r.error === undefined);
    byMode[mode] = {
      runs: ok.length,
      passRate: ok.length === 0 ? 0 : ok.filter((r) => r.pass).length / ok.length,
      meanTokens: mean(ok.map((r) => r.tokens)),
      p95LatencyMs: p95(ok.map((r) => r.latencyMs)),
      wrongOnRelatedOnly: ok.filter((r) => !r.pass && r.seenMatches !== undefined && r.seenMatches.length > 0 && r.seenMatches.every((m) => m === 'related')).length,
      errors: ofMode.length - ok.length,
    };
  }
  return { byMode };
}
