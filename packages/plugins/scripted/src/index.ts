import type {
  DreamPlugin,
  ReasoningRequest,
  ReasoningStrategy,
  RegisteredTool,
  Thought,
} from '@dream/kernel';

export type ReasoningBehavior = (req: ReasoningRequest) => Thought | Promise<Thought>;

/**
 * A deterministic reasoning strategy used by tests, evals and the offline
 * demo. Behavior is swapped at runtime via `set`; every call is logged so
 * evals can assert how often explicit reasoning was needed.
 */
export class ScriptedReasoningPlugin implements DreamPlugin {
  readonly name = 'reasoning-scripted';
  readonly memory = { recall: true };

  calls = 0;
  private behavior: ReasoningBehavior = async () => ({ kind: 'final', content: 'ok' });

  set(behavior: ReasoningBehavior): void {
    this.behavior = behavior;
  }

  apply(ctx: Parameters<DreamPlugin['apply']>[0]): void {
    const plugin = this;
    const strategy: ReasoningStrategy = {
      id: 'scripted',
      async think(req) {
        plugin.calls++;
        return plugin.behavior(req);
      },
    };
    ctx.cognition.register(strategy);
  }
}

/** Ready-made behaviors. */
export const behaviors = {
  answer:
    (content: string): ReasoningBehavior =>
    async () => ({ kind: 'final', content }),

  /** Call a tool on the first pass; answer once the tool result is in WM. */
  toolThenAnswer:
    (name: string, args: unknown, answer: string): ReasoningBehavior =>
    async (req) => {
      if (req.wm.items.some((i) => i.kind === 'tool_result')) {
        return { kind: 'final', content: answer };
      }
      return { kind: 'tool_calls', calls: [{ name, args }] };
    },

  /** Ask for recall first; then echo the recalled memories into the answer. */
  recallEcho:
    (): ReasoningBehavior =>
    async (req) => {
      if (req.recalledNodes.length === 0) {
        return { kind: 'recall', query: req.userText };
      }
      return {
        kind: 'final',
        content: `From memory: ${req.recalledNodes.map((n) => n.content).join(' | ')}`,
      };
    },

  /** Correct the first recalled memory with the given content. */
  correctFirstRecall:
    (content: string): ReasoningBehavior =>
    async (req) => {
      const target = req.recalledNodes[0];
      if (!target) return { kind: 'recall', query: req.userText };
      return { kind: 'correct', nodeId: target.id, content, priority: 'user', reason: 'user correction' };
    },

  /**
   * Correct the recalled memory matching a predicate — models how reasoning
   * picks the specific contradicting memory rather than an arbitrary one.
   */
  correctWhere:
    (predicate: (node: { id: string; content: string; kind: string }) => boolean, content: string): ReasoningBehavior =>
    async (req) => {
      const target = req.recalledNodes.find((n) => predicate(n));
      if (!target) return { kind: 'recall', query: req.userText };
      return { kind: 'correct', nodeId: target.id, content, priority: 'user', reason: 'user correction' };
    },

  /** Always emit the same tool call — exercises loop detection. */
  sameToolForever:
    (name: string, args: unknown): ReasoningBehavior =>
    async () => ({ kind: 'tool_calls', calls: [{ name, args }] }),

  /** Always emit a tool call with unique args — exercises the step budget. */
  uniqueToolForever:
    (name: string): ReasoningBehavior => {
      let n = 0;
      return async () => ({ kind: 'tool_calls', calls: [{ name, args: { n: ++n } }] });
    },
};

/** Two harmless mock tools so demos and evals exercise the tool pipeline. */
export class MockToolsPlugin implements DreamPlugin {
  readonly name = 'tools-mock';

  apply(ctx: Parameters<DreamPlugin['apply']>[0]): void {
    const analyze: RegisteredTool = {
      name: 'analyze',
      description: 'Analyze a dataset and report trends.',
      parameters: {
        type: 'object',
        properties: { dataset: { type: 'string' } },
        required: ['dataset'],
      },
      handler: (args) => {
        const { dataset } = args as { dataset: string };
        return `Analysis of ${dataset}: revenue +12%, churn -3% (mock)`;
      },
    };
    const weather: RegisteredTool = {
      name: 'weather',
      description: 'Get the weather for a city.',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      },
      handler: (args) => {
        const { city } = args as { city: string };
        return `Weather in ${city}: sunny, 22C (mock)`;
      },
    };
    ctx.tools.register(analyze);
    ctx.tools.register(weather);
  }
}
