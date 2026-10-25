import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { serve } from '../src/gateway';

/**
 * The gateway is the project's only public attack surface and was previously
 * the only untested module. These tests cover the crash vectors found in
 * audit (non-string chat text, receiver errors, oversized frames, garbage
 * bytes) plus the basic protocol loop.
 *
 * Frames are buffered from the instant the socket opens: on loopback the
 * server's `hello` can arrive in the same event-loop turn as `open`, so
 * registering a message listener only after awaiting the open event misses
 * it (that race cost a debugging session — keep the buffer-from-connect).
 */

const PORT = 7397;
let closeHandle: (() => Promise<void>) | null = null;

beforeAll(async () => {
  const handle = await serve({
    port: PORT,
    preset: 'companion',
    maxPayloadBytes: 100_000,
    minMessageIntervalMs: 0,
  });
  closeHandle = handle.close;
});

afterAll(async () => {
  await closeHandle?.();
});

interface Frame {
  type: string;
  [key: string]: unknown;
}

class TestClient {
  readonly ws: WebSocket;
  private readonly frames: Frame[] = [];
  private closed = false;
  private error: Error | null = null;
  private readonly waiters = new Set<() => void>();

  constructor(port: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const rawToString = (data: unknown): string => {
      if (Array.isArray(data)) return Buffer.concat(data as Buffer[]).toString('utf8');
      if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
      return (data as Buffer).toString('utf8');
    };
    // ws can deliver a fragmented message as Buffer[] — mirror the gateway.
    this.ws.on('message', (data) => {
      try {
        this.frames.push(JSON.parse(rawToString(data)) as Frame);
      } catch {
        // ignore unparseable frames, same as the client app does
      }
      this.notify();
    });
    this.ws.on('open', () => this.notify());
    this.ws.on('close', () => {
      this.closed = true;
      this.notify();
    });
    this.ws.on('error', (err) => {
      this.error = err;
      this.notify();
    });
  }

  private notify(): void {
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }

  /** Resolves once the socket is open; rejects on connection error. */
  async untilOpen(timeoutMs = 5000): Promise<this> {
    const deadline = Date.now() + timeoutMs;
    while (this.ws.readyState !== WebSocket.OPEN) {
      if (this.error) throw this.error;
      if (Date.now() > deadline) throw new Error('timeout waiting for open');
      await new Promise<void>((resolve) => {
        this.waiters.add(resolve);
        setTimeout(resolve, 25);
      });
    }
    return this;
  }

  async nextOfType(type: string, timeoutMs = 5000): Promise<Frame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const idx = this.frames.findIndex((f) => f.type === type);
      if (idx >= 0) return this.frames.splice(idx, 1)[0]!;
      if (this.error) throw this.error;
      if (this.closed) throw new Error(`connection closed while waiting for "${type}"`);
      if (Date.now() > deadline) throw new Error(`timeout waiting for "${type}"`);
      await new Promise<void>((resolve) => {
        this.waiters.add(resolve);
        setTimeout(resolve, 25);
      });
    }
  }

  sendRaw(payload: unknown): void {
    this.ws.send(payload as never);
  }

  send(frame: Frame): void {
    this.sendRaw(JSON.stringify(frame));
  }

  close(): void {
    this.ws.close();
  }
}

function open(): Promise<TestClient> {
  const client = new TestClient(PORT);
  return client.untilOpen();
}

describe('dream gateway', () => {
  it('greets new connections', async () => {
    const client = await open();
    const hello = await client.nextOfType('hello');
    expect(hello.preset).toBe('companion');
    client.close();
  });

  it('answers a chat turn with a reply frame', async () => {
    const client = await open();
    await client.nextOfType('hello');
    client.send({ type: 'chat', text: 'hello dream' });
    const reply = await client.nextOfType('reply');
    expect(typeof reply.text).toBe('string');
    expect((reply.text as string).length).toBeGreaterThan(0);
    client.close();
  });

  it('survives a non-string text field and answers with an error frame', async () => {
    const client = await open();
    await client.nextOfType('hello');
    client.sendRaw(JSON.stringify({ type: 'chat', text: 12345 }));
    const err = await client.nextOfType('error');
    expect(String(err.message)).toMatch(/string/i);
    // The process and this very connection must still work afterwards.
    client.send({ type: 'chat', text: 'still alive?' });
    const reply = await client.nextOfType('reply');
    expect(typeof reply.text).toBe('string');
    client.close();
  });

  it('survives object/array text fields, bad JSON and garbage bytes', async () => {
    const client = await open();
    await client.nextOfType('hello');
    client.sendRaw(JSON.stringify({ type: 'chat', text: { nested: true } }));
    client.sendRaw('this is not json');
    client.sendRaw(Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x02]));
    client.sendRaw(JSON.stringify({ type: 'revive', id: 42 }));
    client.sendRaw(JSON.stringify({ type: 'memories', limit: 'lots' }));
    // Whatever came back, the server must still be serving.
    client.send({ type: 'stats' });
    const stats = await client.nextOfType('stats');
    expect(Array.isArray(stats.stats)).toBe(true);
    client.close();
  });

  it('kills only the oversized connection, not the server', async () => {
    const client = await open();
    await client.nextOfType('hello');
    client.sendRaw(Buffer.alloc(150_000, 0x61));
    // ws terminates the peer that violates maxPayload.
    const closed = new Promise<void>((resolve) => client.ws.on('close', () => resolve()));
    await closed;
    // A fresh connection must still succeed.
    const client2 = await open();
    const hello = await client2.nextOfType('hello');
    expect(hello.type).toBe('hello');
    client2.close();
  });

  it('runs a dream cycle on request', async () => {
    const client = await open();
    await client.nextOfType('hello');
    client.send({ type: 'dream' });
    const report = await client.nextOfType('dream-report');
    expect(report.report).toBeTruthy();
    client.close();
  });
});
