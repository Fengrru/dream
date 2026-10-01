import type { EmbeddingProvider } from '@dream/core';
import type {
  DreamPlugin,
  ReasoningRequest,
  ReasoningStrategy,
  Thought,
} from '@dream/kernel';

export interface OpenAIReasoningConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  temperature?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Extra system-prompt guidance appended after Dream's standard preamble. */
  systemPreamble?: string;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

function buildSystemPrompt(req: ReasoningRequest, preamble?: string): string {
  const memoryBlock =
    req.recalledNodes.length > 0
      ? req.recalledNodes
          .map((n) => `- [${n.kind}${n.primed ? ', primed' : ''}] ${n.content}`)
          .join('\n')
      : '- (nothing recalled for this turn)';
  const wmBlock =
    req.wm.items.length > 0
      ? req.wm.items.map((i) => `- (${i.kind}, activation ${i.activation.toFixed(2)}) ${i.content}`).join('\n')
      : '- (working memory empty)';
  const toolsBlock =
    req.tools.length > 0
      ? req.tools.map((t) => `- ${t.name}: ${t.description}`).join('\n')
      : '- (no tools available)';

  return [
    'You are Dream, a memory-centric agent. Your identity, knowledge of the user,',
    'and skills live in a persistent memory system that outlives this conversation.',
    '',
    preamble ? `Additional guidance:\n${preamble}` : '',
    '',
    '== Who you are (self-model) ==',
    req.selfSummary,
    '',
    '== Recalled memories relevant to this turn ==',
    memoryBlock,
    '',
    '== Current working memory ==',
    wmBlock,
    '',
    '== Available tools ==',
    toolsBlock,
    '',
    'Rules:',
    '- Treat recalled memories as things you actually remember; attribute them',
    '  ("you told me...") rather than presenting them as fresh guesses.',
    '- If a recalled memory contradicts what the user just said, treat the user as',
    '  authoritative and correct the memory when the harness asks you to.',
    '- Prefer tool calls when a tool answers the question; otherwise answer directly.',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/**
 * Reasoning strategy backed by any OpenAI-compatible chat-completions API.
 * Pure adapter: no memory, no storage — it reads the working-memory snapshot
 * and the self-model summary, and emits a thought.
 */
export class OpenAIReasoningPlugin implements DreamPlugin {
  readonly name = 'reasoning-openai';
  readonly memory = { recall: true, selfRead: true };

  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly temperature: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly systemPreamble?: string;

  constructor(config: OpenAIReasoningConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? 'gpt-4o-mini';
    this.baseUrl = (config.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.temperature = config.temperature ?? 0.3;
    this.timeoutMs = config.timeoutMs ?? 60_000;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.systemPreamble = config.systemPreamble;
  }

  apply(ctx: Parameters<DreamPlugin['apply']>[0]): void {
    const plugin = this;
    const strategy: ReasoningStrategy = {
      id: 'openai',
      async think(req: ReasoningRequest): Promise<Thought> {
        return plugin.think(req);
      },
    };
    ctx.cognition.register(strategy);
  }

  private async think(req: ReasoningRequest): Promise<Thought> {
    const messages: ChatMessage[] = [
      { role: 'system', content: buildSystemPrompt(req, this.systemPreamble) },
      { role: 'user', content: req.userText },
    ];

    const body: Record<string, unknown> = {
      model: this.model,
      temperature: this.temperature,
      messages,
    };
    if (req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      body.tool_choice = 'auto';
    }

    const res = await this.request(body);
    const message = res.choices?.[0]?.message;
    if (!message) {
      return { kind: 'final', content: '(empty response from reasoning model)' };
    }

    if (message.tool_calls && message.tool_calls.length > 0) {
      const calls = message.tool_calls
        .map((tc) => {
          try {
            return { name: tc.function.name, args: JSON.parse(tc.function.arguments || '{}') };
          } catch {
            return { name: tc.function.name, args: { _unparsed: tc.function.arguments } };
          }
        });
      return { kind: 'tool_calls', calls };
    }

    return { kind: 'final', content: message.content ?? '' };
  }

  private async request(body: Record<string, unknown>): Promise<OpenAIChatResponse> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!res.ok) {
          const err = new Error(`reasoning request failed: HTTP ${res.status}`);
          if (res.status === 429 || res.status >= 500) {
            lastError = err;
          } else {
            throw err;
          }
        } else {
          return (await res.json()) as OpenAIChatResponse;
        }
      } catch (err) {
        if (
          err instanceof Error &&
          err.message.startsWith('reasoning request failed') &&
          !/HTTP (429|5\d\d)/.test(err.message)
        ) {
          throw err;
        }
        lastError = err;
      }
      const backoff = 300 * 2 ** attempt + Math.random() * 200;
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
    throw new Error(`reasoning request failed after 3 attempts: ${String(lastError)}`);
  }
}

export interface OpenAIChatResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
    };
  }>;
}

export type { EmbeddingProvider };
