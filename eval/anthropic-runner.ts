import type { AgentRunner, RunInput, RunOutput } from './types.js';

export const MAX_TOOL_CALLS = 8;
export const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2023-06-01';

export class AnthropicApiError extends Error {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(`Anthropic API error ${status}: ${detail}`);
    this.name = 'AnthropicApiError';
  }
}

export interface AnthropicRunnerOptions {
  apiKey: string;
  /** Injected in tests; defaults to the global `fetch` of Node >= 22. */
  fetch?: typeof fetch;
  maxTokens?: number;
  url?: string;
}

interface TextBlock {
  type: 'text';
  text: string;
}
interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}
type ContentBlock = TextBlock | ToolUseBlock | { type: string };

interface MessagesResponse {
  stop_reason?: string;
  content?: ContentBlock[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

const textOf = (blocks: ContentBlock[]): string =>
  blocks
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');

async function errorDetail(res: Response): Promise<string> {
  const raw = await res.text();
  try {
    const body = JSON.parse(raw) as { error?: { type?: string; message?: string } };
    if (body.error?.message) return body.error.type ? `${body.error.type}: ${body.error.message}` : body.error.message;
  } catch {
    // not JSON: fall through to the raw text
  }
  return raw.slice(0, 300) || res.statusText;
}

/**
 * Real runner: the Messages API with a tool-use loop over the tool box, via `fetch`, no SDK. The model comes from
 * the caller (`EVAL_MODEL`); nothing is hard-coded. Tokens are the sum of the API's `usage` input and output
 * fields over the whole loop. At most `MAX_TOOL_CALLS` tool calls per run: the run then stops with the text so far
 * and is marked `capped`.
 */
export class AnthropicRunner implements AgentRunner {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: AnthropicRunnerOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  async run(input: RunInput): Promise<RunOutput> {
    if (!input.model) throw new Error('AnthropicRunner needs a model (set EVAL_MODEL)');
    const started = performance.now();
    const tools = input.tools.specs.map((s) => ({ name: s.name, description: s.description, input_schema: s.input_schema }));
    const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = [{ role: 'user', content: input.prompt }];
    let tokens = 0;
    let toolCalls = 0;
    const allText: string[] = [];

    for (;;) {
      const res = await this.fetchImpl(this.options.url ?? ANTHROPIC_MESSAGES_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.options.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: input.model,
          max_tokens: this.options.maxTokens ?? 2048,
          system: input.system,
          messages,
          ...(tools.length > 0 && { tools }),
        }),
      });
      if (!res.ok) throw new AnthropicApiError(res.status, await errorDetail(res));

      const body = (await res.json()) as MessagesResponse;
      tokens += (body.usage?.input_tokens ?? 0) + (body.usage?.output_tokens ?? 0);
      const content = body.content ?? [];
      const turnText = textOf(content);
      if (turnText !== '') allText.push(turnText);

      const uses = content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
      if (body.stop_reason !== 'tool_use' || uses.length === 0) {
        return { answer: turnText, tokens, toolCalls, latencyMs: Math.round(performance.now() - started) };
      }

      if (toolCalls + uses.length > MAX_TOOL_CALLS) {
        // Cap: execute nothing more, answer with everything said so far.
        return { answer: allText.join('\n'), tokens, toolCalls, capped: true, latencyMs: Math.round(performance.now() - started) };
      }

      messages.push({ role: 'assistant', content });
      const results = uses.map((use) => {
        toolCalls += 1;
        try {
          const r = input.tools.call(use.name, use.input);
          return { type: 'tool_result', tool_use_id: use.id, content: r.text, ...(r.isError && { is_error: true }) };
        } catch (err) {
          return { type: 'tool_result', tool_use_id: use.id, content: err instanceof Error ? err.message : String(err), is_error: true };
        }
      });
      messages.push({ role: 'user', content: results });
    }
  }
}
