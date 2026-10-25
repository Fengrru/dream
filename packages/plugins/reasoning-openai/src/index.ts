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

const RECALL_TOOL = 'memory_recall';
const CORRECT_TOOL = 'memory_correct';

const MEMORY_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: RECALL_TOOL,
      description:
        'Search long-term memory for a specific query. Use when the recalled-memory block is empty or insufficient.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to search for in memory.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: CORRECT_TOOL,
      description:
        'Rewrite a remembered fact the user just corrected. Only use nodeId values shown in the recalled-memory block.',
      parameters: {
        type: 'object',
        properties: {
          nodeId: { type: 'string' },
          content: { type: 'string', description: 'The corrected fact.' },
          reason: { type: 'string' },
        },
        required: ['nodeId', 'content'],
      },
    },
  },
];

function buildSystemPrompt(req: ReasoningRequest, preamble?: string): string {
  const memoryBlock =
    req.recalledNodes.length > 0
      ? req.recalledNodes
          .map((n) => `- [${n.kind}${n.primed ? ', primed' : ''}] (id: ${n.id}) ${n.content}`)
          .join('\n')
      : '- (nothing recalled for this turn)';
  const wmBlock =
    req.wm.items.length > 0
      ? req.wm.items.map((i) => `- (${i.kind}, activation ${i.activation.toFixed(2)}) ${i.content}`).join('\n')
      : '- (working memory empty)';
  const toolsBlock =
    req.tools.length > 0
      ? req.tools.map((t) => `- ${t.name}: ${t.description}`).join('\n')
      : '- (no external tools available)';
  const memoryToolsBlock = `- ${RECALL_TOOL}: search long-term memory for a query.
- ${CORRECT_TOOL}: rewrite a memory by id after the user corrects it.`;

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
    memoryToolsBlock,
    '',
    'Rules:',
    '- Treat recalled memories as things you actually remember; attribute them',
    '  ("you told me...") rather than presenting them as fresh guesses.',
    '- If the recalled-memory block does not contain what you need, call',
    `  ${RECALL_TOOL} instead of guessing.`,
    '- If a recalled memory contradicts what the user just said, treat the user as',
    `  authoritative and call ${CORRECT_TOOL} with that memory's id. Never invent ids.`,
    '- Never claim to remember something that is not in the recalled block.',
    '- The current user message is NEW input, even if it also appears in working',
    '  memory. Do not answer "you already told me" about the message being replied to.',
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
      ...req.conversation.map((turn) => ({ role: turn.role, content: turn.content })),
      { role: 'user', content: req.userText },
    ];

    const body: Record<string, unknown> = {
      model: this.model,
      temperature: this.temperature,
      messages,
    };
    body.tools = [
      ...req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
      ...MEMORY_TOOLS,
    ];
    body.tool_choice = 'auto';

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

      // Memory control actions are first-class thoughts, not tools: the
      // executive handles them directly (recall opens the bus; correct uses
      // the reconsolidation window).
      const recallCall = calls.find((c) => c.name === RECALL_TOOL);
      if (recallCall) {
        const query = (recallCall.args as { query?: unknown }).query;
        return { kind: 'recall', query: typeof query === 'string' && query ? query : req.userText };
      }
      const correctCall = calls.find((c) => c.name === CORRECT_TOOL);
      if (correctCall) {
        const args = correctCall.args as { nodeId?: unknown; content?: unknown; reason?: unknown };
        const nodeId = typeof args.nodeId === 'string' ? args.nodeId : '';
        const content = typeof args.content === 'string' ? args.content : '';
        if (!content || !req.recalledNodes.some((n) => n.id === nodeId)) {
          return {
            kind: 'final',
            content: 'I can only rewrite a specific memory that was just recalled; no matching memory id was available.',
          };
        }
        return {
          kind: 'correct',
          nodeId,
          content,
          priority: 'user',
          reason: typeof args.reason === 'string' ? args.reason : 'user correction',
        };
      }

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
