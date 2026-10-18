/**
 * Stage-level tracing for memory operations.
 *
 * A memory system that cannot explain "why was this recalled / why was this
 * dropped" is untestable in production. Trace events carry counts, durations
 * and hashes — never content by default — so the inspector is safe to persist
 * and print.
 */

export type TraceStage =
  | 'encode'
  | 'embed'
  | 'semantic'
  | 'episodic'
  | 'procedural'
  | 'lexical'
  | 'spread'
  | 'dedup'
  | 'recall'
  | 'dream'
  | 'tool'
  | 'revision'
  | 'policy'
  | 'query-rewrite'
  | 'intention'
  | 'reinforce';

export interface TraceEventInput {
  traceId: string;
  stage: TraceStage;
  ts?: number;
  durationMs?: number;
  meta?: Record<string, string | number | boolean | undefined>;
}

export interface TraceEvent {
  traceId: string;
  stage: TraceStage;
  ts: number;
  durationMs?: number;
  meta?: Record<string, string | number | boolean | undefined>;
}

import type { Journal } from './types';

export interface Tracer {
  readonly enabled: boolean;
  event(input: TraceEventInput): void;
  list(traceId?: string): TraceEvent[];
  clear(): void;
}

/** Bounded in-memory tracer (default). Deterministic for tests and evals. */
export class InMemoryTracer implements Tracer {
  readonly enabled = true;
  private events: TraceEvent[] = [];

  constructor(private readonly maxEvents = 20_000) {}

  event(input: TraceEventInput): void {
    this.events.push({
      ...input,
      ts: input.ts ?? Date.now(),
      meta: input.meta ? { ...input.meta } : undefined,
    });
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
  }

  list(traceId?: string): TraceEvent[] {
    return this.events
      .filter((event) => traceId === undefined || event.traceId === traceId)
      .map((event) => ({ ...event, meta: event.meta ? { ...event.meta } : undefined }));
  }

  clear(): void {
    this.events = [];
  }
}

export class NoopTracer implements Tracer {
  readonly enabled = false;
  event(): void {}
  list(): TraceEvent[] {
    return [];
  }
  clear(): void {}
}

/**
 * Wraps another tracer and mirrors every event into the journal, so channel
 * events emitted inside activation survive a restart and are visible to
 * `dream inspect`. Journal writes are best-effort and never block recall.
 */
export class PersistentTracer implements Tracer {
  constructor(
    private readonly inner: Tracer,
    private readonly journal: Journal,
    private readonly onError?: (error: unknown) => void,
  ) {}

  get enabled(): boolean {
    return this.inner.enabled;
  }

  event(input: TraceEventInput): void {
    this.inner.event(input);
    if (!this.inner.enabled) return;
    void this.journal
      .append({
        ts: input.ts ?? Date.now(),
        type: 'trace',
        meta: {
          ...(input.meta ?? {}),
          traceId: input.traceId,
          stage: input.stage,
          durationMs: input.durationMs,
        },
      })
      .catch((error) => this.onError?.(error));
  }

  list(traceId?: string): TraceEvent[] {
    return this.inner.list(traceId);
  }

  clear(): void {
    this.inner.clear();
  }
}

export interface TraceMetrics {
  totalEvents: number;
  byStage: Record<string, { count: number; totalMs: number; avgMs: number }>;
}

export function traceMetrics(events: TraceEvent[]): TraceMetrics {
  const byStage: TraceMetrics['byStage'] = {};
  for (const event of events) {
    const entry = (byStage[event.stage] ??= { count: 0, totalMs: 0, avgMs: 0 });
    entry.count += 1;
    entry.totalMs += event.durationMs ?? 0;
  }
  for (const entry of Object.values(byStage)) {
    entry.totalMs = Math.round(entry.totalMs * 100) / 100;
    entry.avgMs = entry.count > 0 ? Math.round((entry.totalMs / entry.count) * 100) / 100 : 0;
  }
  return { totalEvents: events.length, byStage };
}
