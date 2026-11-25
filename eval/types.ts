export const EVAL_MODES = ['top5', 'search_then_get', 'read_all'] as const;
export type EvalMode = (typeof EVAL_MODES)[number];

export interface RubricItem {
  must_include?: string[];
  must_not_include?: string[];
}

export interface EvalTask {
  id: string;
  prompt: string;
  repo: string;
  required_cards: string[];
  exceptions?: string[];
  rubric: RubricItem[];
}

/** A tool as the Messages API wants it: name, description and a JSON schema for the input. */
export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ToolResult {
  /** Exactly the text the real server handler returned (or its typed error body). */
  text: string;
  isError: boolean;
}

export interface ToolBoxStats {
  calls: number;
  /** Every `match` label of every search result the agent saw. */
  seenMatches: string[];
  /** Ids of cards the agent saw, from search results or get_card. */
  seenCards: string[];
  getCardCalls: number;
  /** get_card calls for a card already fetched earlier in the same run. */
  refetchCalls: number;
  /** Characters returned by those re-fetches (the API does not attribute tokens per call, so this is not estimated into tokens). */
  refetchChars: number;
}

export interface ToolBox {
  /** The tools the agent may use in this mode; empty for read_all. */
  readonly specs: ToolSpec[];
  /** Runs a tool; throws `ToolNotAllowedError` for a tool this mode does not offer. */
  call(name: string, args: unknown): ToolResult;
  stats(): ToolBoxStats;
}

export interface RunInput {
  task: EvalTask;
  mode: EvalMode;
  model: string;
  tools: ToolBox;
  /** The user message, built by the harness (for read_all it contains every eligible card). */
  prompt: string;
  system: string;
}

export interface RunOutput {
  answer: string;
  /** Input + output tokens from the API `usage` fields, summed over the tool loop. Never estimated. */
  tokens: number;
  toolCalls: number;
  latencyMs: number;
  /** True when the run hit the tool-call cap and was stopped with the answer so far. */
  capped?: boolean;
}

export interface AgentRunner {
  run(input: RunInput): Promise<RunOutput>;
}

export interface EvalResult {
  taskId: string;
  mode: EvalMode;
  /** Compact-pair variant label (`full` | `compact`); absent in a normal run. */
  variant?: string;
  run: number;
  pass: boolean;
  failed: string[];
  answer: string;
  tokens: number;
  toolCalls: number;
  latencyMs: number;
  capped?: boolean;
  seenMatches?: string[];
  seenCards?: string[];
  refetchCalls?: number;
  refetchChars?: number;
  /** Set when the runner threw (API error, network): the run is excluded from the arithmetic. */
  error?: string;
}
