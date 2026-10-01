import { describe, expect, it } from 'vitest';
import type { ApprovalService } from '@dream/policies';
import { buildKernel } from './fixtures';

function approvingService(): ApprovalService & { requests: number } {
  return {
    requests: 0,
    async request() {
      this.requests++;
      return 'allow';
    },
  };
}

describe('Policy presets and fail-closed approvals', () => {
  it('companion without an approval service: destructive asks resolve to deny', async () => {
    const { kernel, store } = await buildKernel();
    const node = await kernel.encodeChunk({ content: 'to be forgotten', kind: 'percept', source: 'user' });
    const ok = await kernel.forgetMemory(node!.id, 'user asked to forget');
    expect(ok).toBe(false);
    expect(await store.getNode(node!.id)).not.toBeNull();
    const policyEvents = (await store.list()).filter((e) => e.type === 'policy');
    expect(policyEvents.length).toBeGreaterThan(0);
    expect(policyEvents[0]!.meta?.['decision']).toBe('deny');
  });

  it('companion with an approving service: forget succeeds and leaves a tombstone', async () => {
    const approval = approvingService();
    const { kernel, store } = await buildKernel({ approval });
    const node = await kernel.encodeChunk({ content: 'forgettable secret', kind: 'percept', source: 'user' });
    const ok = await kernel.forgetMemory(node!.id, 'right to erasure');
    expect(ok).toBe(true);
    expect(approval.requests).toBe(1);
    expect(await store.getNode(node!.id)).toBeNull();
    const purge = (await store.list()).find((e) => e.type === 'purge');
    expect(purge).toBeDefined();
    expect(JSON.stringify(await store.list())).not.toContain('forgettable secret');
  });

  it('headless denies destructive asks even with an approval service mounted', async () => {
    const approval = approvingService();
    const { kernel } = await buildKernel({ config: { preset: 'headless' }, approval });
    const node = await kernel.encodeChunk({ content: 'headless memory', kind: 'percept', source: 'user' });
    expect(node).not.toBeNull(); // encode is allowed in headless
    const ok = await kernel.forgetMemory(node!.id, 'try to forget');
    expect(ok).toBe(false);
    expect(approval.requests).toBe(0); // never even asked: structural denial
  });

  it('amnesiac can recall but never encodes', async () => {
    const { kernel, store } = await buildKernel({ config: { preset: 'amnesiac' } });
    const node = await kernel.encodeChunk({ content: 'should not persist', kind: 'percept', source: 'user' });
    expect(node).toBeNull();
    expect((await store.listNodes()).length).toBe(0);

    // Seed via direct store access to verify recall still works.
    const { EncodingGate } = await import('@dream/core');
    void EncodingGate;
    const { kernel: seededKernel } = await buildKernel();
    const seeded = await seededKernel.encodeChunk({ content: 'stable fact about the user', kind: 'percept', source: 'user' });
    // copy into the amnesiac store
    const seededNode = await seededKernel.store.getNode(seeded!.id);
    await store.putNode(seededNode!);
    const recall = await kernel.recallContext('stable fact about the user');
    expect(recall.nodes.length).toBeGreaterThan(0);
  });
});
