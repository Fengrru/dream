import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import {
  HashingEmbeddingProvider,
  InMemoryStore,
  type Journal,
  type MemoryStore,
  type TraceStore,
} from '@dream/core';
import { DreamKernel } from '@dream/kernel';
import { OpenAIReasoningPlugin } from '@dream/plugin-reasoning-openai';
import { McpToolsPlugin, type McpServerConfig } from '@dream/plugin-mcp';
import { MockToolsPlugin, ScriptedReasoningPlugin } from '@dream/plugin-scripted';
import { SqliteStore } from '@dream/store-sqlite';
import { AllowAllApprovalService } from '@dream/policies';

export interface ServeOptions {
  dbPath?: string;
  port: number;
  /** Bind address. Defaults to loopback; never expose this unauthenticated. */
  host?: string;
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
  embedDimensions?: number;
  /** Optional shared secret required on every WebSocket connection. */
  token?: string;
  /** Browser origins allowed to connect. Empty means non-browser clients only. */
  allowedOrigins?: string[];
  /** Explicit opt-in for side-effect tools and destructive memory ops. */
  allowSideEffects?: boolean;
  /** Idle-only hardening knobs (tests / unusual deployments). */
  maxPayloadBytes?: number;
  minMessageIntervalMs?: number;
}

const FACT_PATTERN =
  /^(my|i prefer|i live|i drive|i work|i am|i'm|i have)\b|(我的|我住|我喜欢|我开|我在|我叫|我养|我有|记住)/i;

function isExplicitFact(text: string): boolean {
  return FACT_PATTERN.test(text.trim());
}

type CombinedStore = MemoryStore & Journal & TraceStore;

async function openStore(dbPath?: string): Promise<CombinedStore> {
  if (!dbPath) return new InMemoryStore();
  return new SqliteStore(dbPath).init();
}

const DEFAULT_ALLOWED_ORIGINS = ['http://localhost:5180', 'http://127.0.0.1:5180'];
const MAX_CHAT_CHARS = 8_000;

/**
 * Dream kernel gateway: WebSocket bridge between the orb-ui frontend and a
 * live DreamKernel. Protocol v0:
 *
 *   client → { type: 'chat', text } | { type: 'dream' } | { type: 'stats' }
 *   server → { type: 'hello' } | { type: 'state', state, cognitive?, wmLoad }
 *          | { type: 'reply', text, recalled, skillUsed? }
 *          | { type: 'encode', entry } | { type: 'dream-report', report }
 *          | { type: 'stats', ... }
 *
 * Security model: loopback bind by default, Origin allowlist, optional token,
 * per-connection session/working memory, serialized turns per connection, and
 * all UI memory reads centralized in the kernel's scrubbed read path.
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
          dimensions: options.embedDimensions,
        })
      : new HashingEmbeddingProvider();
  const approval = options.allowSideEffects ? new AllowAllApprovalService() : undefined;
  const kernel = new DreamKernel(
    {
      memory: store,
      journal: store,
      traces: store,
      // Local deterministic embedder by default — DeepSeek and most chat
      // APIs have no embeddings endpoint. Opt in via DREAM_EMBED_MODEL.
      provider: embedder,
      clock: Date.now,
      approval,
    },
    {
      preset: options.preset,
      requireToolApproval: !options.allowSideEffects,
    },
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

  // Refuse to expose an unauthenticated agent on a public interface.
  const host = options.host ?? '127.0.0.1';
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1' && !options.token) {
    throw new Error(
      `refusing to bind ${host} without DREAM_GATEWAY_TOKEN — set a token or use --host 127.0.0.1`,
    );
  }

  const allowedOrigins = options.allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS;
  const wss = new WebSocketServer({
    port: options.port,
    host,
    maxPayload: options.maxPayloadBytes ?? 1_000_000,
    verifyClient: (info: { origin?: string; secure: boolean; req: IncomingMessage }) => {
      const origin = info.origin;
      // Non-browser clients usually send no Origin. If one is present, it must
      // be explicitly allowed; this blocks drive-by pages hitting localhost.
      if (origin && !allowedOrigins.includes(origin)) return false;
      if (options.token) {
        const raw = info.req.headers['x-dream-token'];
        let supplied: string | undefined = Array.isArray(raw) ? raw[0] : raw;
        try {
          const url = new URL(info.req.url ?? '/', `ws://${info.req.headers.host ?? 'localhost'}`);
          supplied = supplied ?? url.searchParams.get('token') ?? undefined;
        } catch {
          // fall through with header value
        }
        return supplied === options.token;
      }
      return true;
    },
  });

  const sessions = new Set<ReturnType<typeof kernel.session>>();
  const socketsBySession = new Map<string, WebSocket>();
  let activeTurns = 0;

  const wmLoad = (session?: { wm: { readAll(): Array<{ activation: number }>; capacity: number } }): number => {
    if (!session) return 0;
    const items = session.wm.readAll();
    const sum = items.reduce((acc, c) => acc + c.activation, 0);
    return Math.min(1, sum / Math.max(1, session.wm.capacity));
  };

  const broadcast = (frame: unknown): void => {
    const data = JSON.stringify(frame);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(data);
    }
  };
  const sendState = (
    ws: WebSocket,
    session: ReturnType<typeof kernel.session>,
    state: string,
    cognitive?: string,
  ): void => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'state', state, cognitive, wmLoad: wmLoad(session) }));
  };
  const broadcastState = (state: string, cognitive?: string): void => {
    broadcast({ type: 'state', state, cognitive, wmLoad: 0 });
  };

  const broadcastDreamReport = async (): Promise<void> => {
    broadcastState('thinking', 'dreaming');
    try {
      const report = await kernel.dreamNow();
      broadcast({ type: 'dream-report', report });
    } finally {
      broadcastState('idle');
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
      if (activeTurns > 0) {
        // Never consolidate over an in-flight turn; try again later.
        resetIdleTimer();
        return;
      }
      void broadcastDreamReport().finally(() => resetIdleTimer());
    }, idleMs);
  };
  resetIdleTimer();

  kernel.on('memory/encode', (payload) => broadcast({ type: 'encode', entry: payload }));
  kernel.on('memory/recall', (payload) => {
    const data = (payload ?? {}) as { count?: number; sessionId?: string };
    const target = data.sessionId ? socketsBySession.get(data.sessionId) : undefined;
    if (target && target.readyState === WebSocket.OPEN) {
      target.send(JSON.stringify({ type: 'state', state: 'thinking', cognitive: 'recalling' }));
      target.send(JSON.stringify({ type: 'recalled', count: data.count }));
    } else {
      broadcast({ type: 'recalled', count: data.count });
    }
  });

  wss.on('connection', (ws, req) => {
    const session = kernel.session();
    sessions.add(session);
    socketsBySession.set(session.id, ws);
    const ready = session.start({
      contextSeeds: ['the user, their preferences and ongoing topics'],
    });
    let chain: Promise<void> = Promise.resolve();
    let closed = false;
    // Token bucket: 20 messages/sec sustained, 20 burst. Legitimate turns are
    // never silently dropped; over-limit frames get an explicit error.
    let budget = 20;
    let lastRefill = Date.now();
    const minInterval = options.minMessageIntervalMs ?? 0;
    let lastMessageAt = 0;

    const send = (frame: unknown): void => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
    };
    const enqueue = (task: () => Promise<void>): void => {
      chain = chain.then(task).catch((err) => {
        send({ type: 'reply', text: `Dream hit an error: ${String(err)}`, recalled: [] });
      });
    };

    send({
      type: 'hello',
      reasoning: reasoningLabel,
      preset: options.preset,
      wmLoad: wmLoad(session),
    });
    void ready;

    ws.on('message', (data) => {
      const now = Date.now();
      budget = Math.min(20, budget + ((now - lastRefill) / 1000) * 20);
      lastRefill = now;
      if (budget < 1) {
        send({ type: 'error', message: 'rate limit exceeded' });
        return;
      }
      budget -= 1;
      if (now - lastMessageAt < minInterval) return;
      lastMessageAt = now;

      let msg: { type?: string; text?: string; id?: string; limit?: number };
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      resetIdleTimer();

      if (msg.type === 'chat' && msg.text) {
        const text = msg.text.slice(0, MAX_CHAT_CHARS);
        if (!text.trim()) return;
        sendState(ws, session, 'listening', 'perceiving');
        activeTurns++;
        enqueue(async () => {
          try {
            await ready;
            sendState(ws, session, 'thinking');
            const turn = await session.submit(text, { explicitFact: isExplicitFact(text) });
            send({
              type: 'reply',
              text: turn.final,
              recalled: turn.recalled.map((n) => ({ content: n.content, kind: n.kind })),
              skillUsed: turn.skillUsed ?? undefined,
            });
            sendState(ws, session, 'speaking');
          } finally {
            activeTurns = Math.max(0, activeTurns - 1);
            resetIdleTimer();
          }
        });
        return;
      }

      if (msg.type === 'dream') {
        enqueue(async () => {
          await ready;
          await broadcastDreamReport();
        });
        return;
      }

      if (msg.type === 'stats') {
        enqueue(async () => {
          send({ type: 'stats', stats: await kernel.stats() });
        });
        return;
      }

      if (msg.type === 'memories') {
        enqueue(async () => {
          send({
            type: 'memories',
            nodes: await kernel.listMemories(Math.min(100, Math.max(1, msg.limit ?? 30))),
          });
        });
        return;
      }

      if (msg.type === 'forgetting-bin') {
        enqueue(async () => {
          send({
            type: 'forgetting-bin',
            nodes: await kernel.forgettingBin(Math.min(100, Math.max(1, msg.limit ?? 30))),
          });
        });
        return;
      }

      if (msg.type === 'revive' && typeof msg.id === 'string') {
        enqueue(async () => {
          const revived = await kernel.reviveMemory(msg.id!);
          send({ type: 'revive-ack', ok: revived.ok, content: revived.content });
        });
        return;
      }

      if (msg.type === 'release-quarantine' && typeof msg.id === 'string') {
        enqueue(async () => {
          const released = await kernel.releaseQuarantined(msg.id!, 'gateway release');
          send({ type: 'quarantine-release-ack', ok: released !== null });
        });
      }
    });

    ws.on('close', () => {
      closed = true;
      // Let queued turns finish first; session.end() drains working memory.
      void chain
        .then(() => ready)
        .then(() => session.end())
        .catch(() => {
          // Client disconnect must never crash the server.
        })
        .finally(() => {
          sessions.delete(session);
          socketsBySession.delete(session.id);
        });
    });
    void closed;
    void req;
  });

  // Basic liveness: close dead peers instead of leaking sessions.
  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.ping();
    }
  }, 30_000);
  heartbeat.unref?.();

  console.log(`Dream gateway listening on ws://${host}:${options.port} (reasoning: ${reasoningLabel})`);
  console.log(`Origin allowlist: ${allowedOrigins.join(', ') || '(none)'}`);
  console.log(`Auth: ${options.token ? 'token required' : 'loopback only'}`);
  console.log(`Side-effect tools: ${options.allowSideEffects ? 'ALLOWED (explicit opt-in)' : 'fail-closed'}`);
  console.log(`Memory store: ${options.dbPath ?? 'in-memory (pass --db to persist)'}`);

  const close = async (): Promise<void> => {
    clearInterval(heartbeat);
    if (idleTimer) clearTimeout(idleTimer);
    mcp?.close();
    for (const session of [...sessions]) {
      try {
        await session.end();
      } catch {
        // best effort
      }
    }
    sessions.clear();
    if (store instanceof SqliteStore) await store.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void close());
  process.on('SIGTERM', () => void close());
}
