import { describe, expect, it } from 'vitest';
import { InMemoryTracer, traceMetrics } from '../src/tracing';

describe('InMemoryTracer', () => {
  it('records stage events, filters by trace and computes metrics', () => {
    const tracer = new InMemoryTracer();
    tracer.event({ traceId: 't1', stage: 'embed', durationMs: 2, meta: { dims: 256 } });
    tracer.event({ traceId: 't1', stage: 'semantic', durationMs: 4 });
    tracer.event({ traceId: 't2', stage: 'recall', durationMs: 10 });

    expect(tracer.list('t1').map((event) => event.stage)).toEqual(['embed', 'semantic']);
    expect(tracer.list()).toHaveLength(3);
    const metrics = traceMetrics(tracer.list('t1'));
    expect(metrics.totalEvents).toBe(2);
    expect(metrics.byStage['embed']).toEqual({ count: 1, totalMs: 2, avgMs: 2 });
    expect(metrics.byStage['semantic']!.totalMs).toBe(4);
  });

  it('bounds the buffer', () => {
    const tracer = new InMemoryTracer(2);
    tracer.event({ traceId: 'a', stage: 'embed' });
    tracer.event({ traceId: 'b', stage: 'embed' });
    tracer.event({ traceId: 'c', stage: 'embed' });
    expect(tracer.list().map((event) => event.traceId)).toEqual(['b', 'c']);
  });
});
