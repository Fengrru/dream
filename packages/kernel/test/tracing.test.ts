import { describe, expect, it } from 'vitest';
import { behaviors } from '@dream/plugin-scripted';
import { buildKernel } from './fixtures';

describe('Memory tracing', () => {
  it('emits stage events for encode and recall without leaking content', async () => {
    const { kernel, scripted, store } = await buildKernel();

    scripted.set(behaviors.answer('Noted.'));
    const s1 = kernel.session();
    const writeTurn = await s1.submit('My locker combination is 4821', { explicitFact: true });
    expect(writeTurn.traceId).toMatch(/^trace_/);

    scripted.set(behaviors.recallEcho());
    const s2 = kernel.session();
    const readTurn = await s2.submit('What is the locker combination?');

    const writeStages = kernel.traceEvents(writeTurn.traceId).map((event) => event.stage);
    expect(writeStages).toContain('encode');
    expect(kernel.traceEvents(readTurn.traceId).map((event) => event.stage)).toEqual(
      expect.arrayContaining(['embed', 'semantic', 'lexical', 'dedup', 'recall']),
    );

    const serialized = JSON.stringify(kernel.traceEvents());
    expect(serialized).not.toContain('4821');
    expect(serialized).not.toContain('locker combination');

    const metrics = kernel.traceMetrics(readTurn.traceId);
    expect(metrics.byStage['recall']?.count).toBeGreaterThan(0);
    expect(metrics.totalEvents).toBeGreaterThan(3);

    // Persisted trace events are available to `dream inspect` after a turn.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const journal = await store.list();
    expect(journal.some((event) => event.type === 'trace' && event.meta?.['traceId'] === readTurn.traceId)).toBe(
      true,
    );
  });
});
