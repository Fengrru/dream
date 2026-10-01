/**
 * Dream web client.
 *
 * Two signal sources drive the Orb, mirroring the orb-ui demo:
 *  - "Simulation": the same synthetic conversation steps orb-ui's demo uses,
 *    so the page is alive even without a running gateway.
 *  - "Dream (live)": a WebSocket connection to `dream serve` (kernel gateway,
 *    protocol v0 on ws://127.0.0.1:7333).
 */

export type OrbState = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'error';

/** Dream-specific cognitive overlays (the Orb itself only knows OrbState). */
export type CognitiveState = 'perceiving' | 'recalling' | 'dreaming';

export interface DreamReportFrame {
  replayedEpisodes: number;
  abstractions: string[];
  skillsFormed: string[];
  skillsUpdated: string[];
  mergedCount: number;
  fadedCount: number;
  selfUpdates: string[];
}

export interface MemoryRow {
  id: string;
  kind: string;
  content: string;
  strength: number;
  importance: number;
  lastAccessedAt?: number;
}

export type DreamEvent =
  | { type: 'hello'; reasoning?: string; preset?: string; wmLoad?: number }
  | { type: 'state'; state: OrbState; cognitive?: CognitiveState; wmLoad?: number }
  | { type: 'reply'; text: string; recalled: Array<{ content: string; kind?: string }>; skillUsed?: string }
  | { type: 'encode'; entry: { content?: string; kind?: string; nodeId?: string } }
  | { type: 'recalled'; count?: number }
  | { type: 'dream-report'; report: DreamReportFrame }
  | { type: 'stats'; stats: Array<{ kind: string; count: number }> }
  | { type: 'memories'; nodes: MemoryRow[] }
  | { type: 'forgetting-bin'; nodes: MemoryRow[] }
  | { type: 'revive-ack'; ok: boolean; content?: string };

export class DreamClient {
  private ws: WebSocket | null = null;
  private handlers = new Set<(e: DreamEvent) => void>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(private readonly url = 'ws://127.0.0.1:7333') {}

  on(handler: (e: DreamEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  connect(): void {
    this.closed = false;
    try {
      this.ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws.onopen = () => this.emit({ type: 'state', state: 'connecting' });
    this.ws.onclose = () => {
      this.emit({ type: 'state', state: 'error' });
      this.scheduleReconnect();
    };
    this.ws.onerror = () => this.ws?.close();
    this.ws.onmessage = (msg) => {
      let frame: DreamEvent;
      try {
        frame = JSON.parse(String(msg.data)) as DreamEvent;
      } catch {
        return;
      }
      this.emit(frame);
    };
  }

  send(frame: { type: 'chat'; text: string } | { type: 'dream' } | { type: 'stats' }): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
  }

  requestMemories(): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'memories' }));
  }

  requestForgettingBin(): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'forgetting-bin' }));
  }

  revive(id: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'revive', id }));
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }

  private emit(e: DreamEvent): void {
    for (const handler of this.handlers) handler(e);
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 2000);
  }
}

// ---------------------------------------------------------------------------
// Simulation signal source (ported from the orb-ui demo)
// ---------------------------------------------------------------------------

export interface SimulationStep {
  state: OrbState;
  duration: number;
}

export const SIMULATION_STEPS: SimulationStep[] = [
  { state: 'connecting', duration: 1000 },
  { state: 'listening', duration: 2600 },
  { state: 'thinking', duration: 900 },
  { state: 'speaking', duration: 3400 },
  { state: 'idle', duration: 1400 },
];

export const SIMULATION_DURATION = SIMULATION_STEPS.reduce((total, s) => total + s.duration, 0);

export function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value));
}

function envelope(elapsed: number, duration: number): number {
  const fadeIn = clamp(elapsed / 320);
  const fadeOut = clamp((duration - elapsed) / 360);
  return Math.min(fadeIn, fadeOut);
}

function simulatedVolume(step: SimulationStep, elapsed: number): number {
  if (step.state !== 'listening' && step.state !== 'speaking') return 0;
  const t = elapsed / 1000;
  const shape = envelope(elapsed, step.duration);
  if (step.state === 'listening') {
    const voice =
      0.22 + Math.sin(t * 7.7) * 0.1 + Math.sin(t * 13.1 + 0.8) * 0.07 + Math.sin(t * 21.2) * 0.04;
    return clamp(voice * shape, 0.02, 0.58);
  }
  const voice =
    0.5 + Math.sin(t * 8.4) * 0.19 + Math.sin(t * 15.6 + 1.2) * 0.13 + Math.sin(t * 25.2) * 0.07;
  return clamp(voice * shape, 0.05, 0.95);
}

export function getSimulationFrame(startedAt: number, now: number): { state: OrbState; volume: number } {
  let elapsed = (now - startedAt) % SIMULATION_DURATION;
  for (const step of SIMULATION_STEPS) {
    if (elapsed <= step.duration) {
      return { state: step.state, volume: simulatedVolume(step, elapsed) };
    }
    elapsed -= step.duration;
  }
  return { state: 'idle', volume: 0 };
}

export function signalFromStateVolume(state: OrbState, volume: number) {
  if (state === 'listening') return { state, inputVolume: volume };
  if (state === 'speaking') return { state, outputVolume: volume };
  return { state };
}
