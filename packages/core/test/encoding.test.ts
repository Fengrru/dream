import { describe, expect, it } from 'vitest';
import { buildCore } from './helpers';
import type { MemoryNode } from '../src/types';

describe('EncodingGate', () => {
  it('encodes user-stated facts as semantic memory with high importance', async () => {
    const { gate } = buildCore();
    const node = await gate.encode({
      content: 'I prefer aisle seats on flights',
      kind: 'percept',
      source: 'user',
      explicitFact: true,
    });
    expect(node).not.toBeNull();
    expect(node!.kind).toBe('semantic');
    expect(node!.importance).toBeGreaterThan(0.6);
    expect(node!.provenance.source).toBe('user');
    expect(node!.provenance.trust).toBe(1);
  });

  it('encodes plain percepts as episodic memory with lower importance', async () => {
    const { gate, store } = buildCore();
    const generic = await gate.encode({ content: 'the build passed', kind: 'percept', source: 'tool' });
    const salient = await gate.encode({
      content: 'this is critical and urgent, deploy now',
      kind: 'percept',
      source: 'user',
    });
    expect(generic!.kind).toBe('episodic');
    expect(salient!.importance).toBeGreaterThan(generic!.importance);
    expect((await store.listNodes()).length).toBe(2);
  });

  it('links similar memories with symmetric edges (elaborative rehearsal)', async () => {
    const { gate, store } = buildCore();
    const a = await gate.encode({ content: 'I love hiking in the mountains', kind: 'percept', source: 'user' });
    const b = await gate.encode({ content: 'I love hiking', kind: 'percept', source: 'user' });
    const edgesOfA = await store.getEdges(a!.id);
    const edgesOfB = await store.getEdges(b!.id);
    expect(edgesOfA.some((e) => e.to === b!.id)).toBe(true);
    expect(edgesOfB.some((e) => e.to === a!.id)).toBe(true);
  });

  it('never encodes intentions', async () => {
    const { gate, store } = buildCore();
    const node = await gate.encode({ content: 'call the user back', kind: 'intention', source: 'agent' });
    expect(node).toBeNull();
    expect((await store.listNodes()).length).toBe(0);
  });
});

describe('Spreading activation', () => {
  it('pre-activates a related subset, splitting working set from primed set', async () => {
    const { gate, provider, store, lifecycle } = buildCore();

    // Build a small associative structure: a semantic hub linked to episodes.
    const hub = await gate.encode({
      content: 'data analysis of sales trends',
      kind: 'percept',
      source: 'user',
      explicitFact: true,
    });
    const episodes: Array<MemoryNode | null> = [];
    for (const content of [
      'analyzed sales data for q1 and found growth',
      'analyzed sales data for q2 and found churn',
      'analyzed sales data for q3, margins improved',
    ]) {
      episodes.push(await gate.encode({ content, kind: 'percept', source: 'user' }));
    }
    for (const ep of episodes) {
      await store.addEdge(ep!.id, { to: hub!.id, type: 'similar', weight: 0.7 });
    }
    await lifecycle.onRecalled(episodes.map((e) => e!.id));

    const activation = await (
      await import('../src/activation')
    ).ActivationEngine;
    const engine = new activation(provider);
    const set = await engine.activate(store, ['analyze sales data trends'], { capacity: 2 });

    expect(set.workingSet.length).toBe(2);
    const workingIds = set.workingSet.map((c) => c.meta?.['nodeId']);
    // The hub must be in or near the focal set; episodes reachable via edges.
    expect(
      workingIds.includes(hub!.id) || set.primed.some((c) => c.meta?.['nodeId'] === hub!.id),
    ).toBe(true);
    expect(set.primed.length).toBeGreaterThan(0);
    expect(set.scores.size).toBeGreaterThan(set.workingSet.length);
  });

  it('retrieval practice keeps an episode fresh against an equally similar one', async () => {
    const { gate, provider, store, clock, lifecycle } = buildCore();
    const recalled = await gate.encode({ content: 'standup meeting notes about the api', kind: 'percept', source: 'user' });
    const ignored = await gate.encode({ content: 'standup meeting notes about the roadmap', kind: 'percept', source: 'user' });
    clock.advance(30 * 24 * 60 * 60 * 1000); // 30 days pass...
    await lifecycle.onRecalled([recalled!.id]); // ...but this one was just retrieved

    const { ActivationEngine } = await import('../src/activation');
    const engine = new ActivationEngine(provider);
    const set = await engine.activate(store, ['standup meeting notes'], {
      capacity: 1,
      now: clock.now,
    });
    expect(set.workingSet[0]!.meta?.['nodeId']).toBe(recalled!.id);
    expect(set.workingSet[0]!.meta?.['nodeId']).not.toBe(ignored!.id);
  });
});
