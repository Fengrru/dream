import { WebSocketServer, WebSocket } from 'ws';
import {
  HashingEmbeddingProvider,
  InMemoryStore,
  clamp,
  type Journal,
  type MemoryStore,
  type TraceStore,
} from '@dream/core';
import { DreamKernel } from '@dream/kernel';
import { OpenAIReasoningPlugin } from '@dream/plugin-reasoning-openai';
import { McpToolsPlugin, type McpServerConfig } from '@dream/plugin-mcp';
import { MockToolsPlugin, ScriptedReasoningPlugin } from '@dream/plugin-scripted';
import { SqliteStore } from '@dream/store-sqlite';

export interface ServeOptions {
  dbPath?: string;
  port: number;
  preset: 'companion' | 'amnesiac' | 'headless';
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  /** Seconds of inactivity before an automatic dream cycle (0 = disabled). */
  idleDreamSeconds?: number;
  /** MCP servers to bridge (stdio transport). */
  mcpServers?: McpServerConfig[];
  /** Embedding provider opt-in (local hashing by default). */
  embedModel?: string;
  embedBaseUrl?: string;
  embedApiKey?: string;
}

const FACT_PATTERN = /^(my|i prefer|i live|i drive|i work)\b/i;

type CombinedStore = MemoryStore & Journal & TraceStore;

async function openStore(dbPath?: string): Promise<CombinedStore> {
  if (!dbPath) return new InMemoryStore();
  return new SqliteStore(dbPath).init();
}

/**
 * Dream kernel gateway: WebSocket bridge between the orb-ui frontend and a
 * live DreamKernel. Protocol v0:
 *
 *   client → { type: 'chat', text } | { type: 'dream' } | { type: 'stats' }
 *   server → { type: 'hello' } | { type: 'state', state, cognitive?, wmLoad }
 *          | { type: 'reply', text, recalled, skillUsed? }
 *          | { type: 'encode', entry } | { type: 'dream-report', report }
 *          | { type: 'stats', ... }
 */
export async function serve(options: ServeOptions): Promise<void> {
  const store: CombinedStore = await openStore(options.dbPath);
  const scripted = new ScriptedReasoningPlugin();
  const embedder =
    options.embedModel && options.embedApiKey
      ? new (await import('@dream/core')).OpenAIEmbeddingProvider({
          apiKey: options.embedApiKey,
          baseUrl: options.embedBaseUrl,
          model: options.embedModel,
        })
      : new HashingEmbeddingProvider();
  const kernel = new DreamKernel(
    {
      memory: store,
      journal: store,
      traces: store,
      // Local deterministic embedder by default — DeepSeek and most chat
      // APIs have no embeddings endpoint. Opt in via DREAM_EMBED_MODEL.
      provider: embedder,
      clock: Date.now,
    },
    { preset: options.preset },
  );

  const reasoningLabel =
    options.apiKey && options.model ? `deepseek:${options.model}` : 'scripted (no API key)';
  if (options.apiKey && options.model) {
    await kernel.use(
      new OpenAIReasoningPlugin({
        apiKey: options.apiKey,
        model: options.model,
        baseUrl: options.baseUrl,
        temperature: 0.6,
      }),
    );
  } else {
    scripted.set(
      async (req) => {
        if (req.recalledNodes.length > 0) {
          return {
            kind: 'final',
            content: `I remember: ${req.recalledNodes.map((n) => n.content).join(' | ')}`,
          };
        }
        return { kind: 'final', content: 'Set DREAM_API_KEY + DREAM_MODEL to enable real reasoning.' };
      },
    );
    await kernel.use(scripted);
  }
  await kernel.use(new MockToolsPlugin());

  let mcp: McpToolsPlugin | null = null;
  if (options.mcpServers && options.mcpServers.length > 0) {
    mcp = new McpToolsPlugin({
      servers: options.mcpServers,
      onLog: (message) => console.log(message),
    });
    await kernel.use(mcp);
  }

  const session = kernel.session();
  await session.start({ contextSeeds: ['the user, their preferences and ongoing topics'] });

  const wss = new WebSocketServer({ port: options.port });
  const wmLoad = (): number => {
    const items = kernel.wm.readAll();
    const sum = items.reduce((acc, c) => acc + c.activation, 0);
    return clamp(sum / Math.max(1, kernel.wm.capacity), 0, 1);
  };
  const broadcast = (frame: unknown): void => {
    const data = JSON.stringify(frame);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(data);
    }
  };
  const setState = (state: string, cognitive?: string): void => {
    broadcast({ type: 'state', state, cognitive, wmLoad: wmLoad() });
  };

  const broadcastDreamReport = async (): Promise<void> => {
    setState('thinking', 'dreaming');
    try {
      const report = await kernel.dreamNow();
      broadcast({ type: 'dream-report', report });
    } finally {
      setState('idle');
    }
  };

  // Idle auto-dream: after inactivity, consolidate (the "sleeps when idle"
  // behavior). Each incoming message resets the timer.
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const idleMs = (options.idleDreamSeconds ?? 0) * 1000;
  const resetIdleTimer = (): void => {
    if (idleMs <= 0) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      void broadcastDreamReport();
    }, idleMs);
  };
  resetIdleTimer();

  kernel.on('memory/encode', (payload) => broadcast({ type: 'encode', entry: payload }));
  kernel.on('memory/recall', (payload) => {
    setState('thinking', 'recalling');
    broadcast({ type: 'recalled', ...((payload as { count?: number }) ?? {}) });
  });

  wss.on('connection', (ws) => {
    ws.send(
      JSON.stringify({
        type: 'hello',
        reasoning: reasoningLabel,
        preset: options.preset,
        wmLoad: wmLoad(),
      }),
    );

    ws.on('message', (data) => {
      let msg: { type?: string; text?: string; id?: string };
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }

      if (msg.type === 'chat' && msg.text) {
        const text = msg.text;
        resetIdleTimer();
        // Perceive → think; the reply frame carries the final answer.
        setState('listening', 'perceiving');
        void (async () => {
          setState('thinking');
          try {
            const turn = await session.submit(text, {
              explicitFact: FACT_PATTERN.test(text),
            });
            broadcast({
              type: 'reply',
              text: turn.final,
              recalled: turn.recalled.map((n) => ({ content: n.content, kind: n.kind })),
              skillUsed: turn.skillUsed ?? undefined,
            });
            setState('speaking');
          } catch (err) {
            broadcast({ type: 'reply', text: `Dream hit an error: ${String(err)}`, recalled: [] });
            setState('idle');
          } finally {
            resetIdleTimer();
          }
        })();
        return;
      }

      if (msg.type === 'dream') {
        resetIdleTimer();
        void broadcastDreamReport().finally(() => resetIdleTimer());
        return;
      }

      if (msg.type === 'stats') {
        void (async () => {
          ws.send(JSON.stringify({ type: 'stats', stats: await kernel.stats() }));
        })();
        return;
      }

      if (msg.type === 'memories') {
        void (async () => {
          const all = await kernel.store.listNodes();
          const recent = [...all]
            .sort((a, b) => b.createdAt - a.createdAt)
            .slice(0, 30)
            .map((n) => ({
              id: n.id,
              kind: n.kind,
              content: n.content,
              strength: Math.round(n.strength * 100) / 100,
              importance: Math.round(n.importance * 100) / 100,
            }));
          ws.send(JSON.stringify({ type: 'memories', nodes: recent }));
        })();
        return;
      }

      if (msg.type === 'forgetting-bin') {
        void (async () => {
          const all = await kernel.store.listNodes();
          const faded = all
            .filter((n) => n.strength < 0.15 && n.kind !== 'procedural')
            .sort((a, b) => a.strength - b.strength)
            .slice(0, 30)
            .map((n) => ({
              id: n.id,
              kind: n.kind,
              content: n.content,
              strength: Math.round(n.strength * 1000) / 1000,
              lastAccessedAt: n.lastAccessedAt,
            }));
          ws.send(JSON.stringify({ type: 'forgetting-bin', nodes: faded }));
        })();
        return;
      }

      if (msg.type === 'revive' && typeof msg.id === 'string') {
        const nodeId = msg.id;
        void (async () => {
          const revived = await kernel.lifecycle.onRecalled([nodeId]);
          const node = await kernel.store.getNode(nodeId);
          ws.send(JSON.stringify({ type: 'revive-ack', ok: revived > 0, content: node?.content }));
        })();
        return;
      }
    });
  });

  console.log(`Dream gateway listening on ws://127.0.0.1:${options.port} (reasoning: ${reasoningLabel})`);
  console.log(`Memory store: ${options.dbPath ?? 'in-memory (pass --db to persist)'}`);

  const close = async (): Promise<void> => {
    if (idleTimer) clearTimeout(idleTimer);
    mcp?.close();
    const end = await session.end();
    console.log(`\nSession ended. Encoded ${end.encoded} memory(ies).`);
    if (end.dreamReport) {
      console.log(
        `Dream report: ${end.dreamReport.replayedEpisodes} episodes, ${end.dreamReport.skillsFormed.length} skills formed.`,
      );
    }
    if (store instanceof SqliteStore) await store.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void close());
  process.on('SIGTERM', () => void close());
}
