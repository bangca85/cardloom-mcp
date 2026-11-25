import type { AgentRunner, RunInput, RunOutput } from './types.js';

export interface StubRunnerOptions {
  /** Canned answers by task id. */
  answers?: Record<string, string>;
  /** Answer for a task with no canned one. */
  defaultAnswer?: string;
  /** Full control for tests: may call `input.tools` and returns the answer. Takes precedence over `answers`. */
  respond?: (input: RunInput) => string | Promise<string>;
}

/** A runner that never touches the network: canned or scripted answers, for tests and the dry-run plumbing. */
export class StubRunner implements AgentRunner {
  constructor(private readonly options: StubRunnerOptions = {}) {}

  async run(input: RunInput): Promise<RunOutput> {
    const answer = this.options.respond
      ? await this.options.respond(input)
      : (this.options.answers?.[input.task.id] ?? this.options.defaultAnswer ?? '');
    return { answer, tokens: 10, toolCalls: input.tools.stats().calls, latencyMs: 1 };
  }
}
