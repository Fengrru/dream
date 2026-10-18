import { describe, expect, it } from 'vitest';
import { ActivationEngine } from '../src/activation';
import { EncodingGate } from '../src/encoding';
import { buildCore } from './helpers';

describe('Owner isolation', () => {
  it('never recalls another user partition', async () => {
    const { gate, store, provider } = buildCore();
    await gate.encode(
      { content: 'Alice prefers aisle seats', kind: 'percept', source: 'user', explicitFact: true },
      { userId: 'alice' },
    );
    await gate.encode(
      { content: 'Bob prefers window seats', kind: 'percept', source: 'user', explicitFact: true },
      { userId: 'bob' },
    );

    const engine = new ActivationEngine(provider);
    const alice = await engine.activate(store, ['What seat does the user prefer?'], {
      capacity: 4,
      userId: 'alice',
    });
    expect(alice.workingSet).toHaveLength(1);
    expect(alice.workingSet[0]!.content).toContain('Alice');

    const bob = await engine.activate(store, ['What seat does the user prefer?'], {
      capacity: 4,
      userId: 'bob',
    });
    expect(bob.workingSet).toHaveLength(1);
    expect(bob.workingSet[0]!.content).toContain('Bob');
  });
});

describe('Scene boost', () => {
  it('prioritises the matching scene without splitting the store', async () => {
    const { gate, store, provider } = buildCore();
    await gate.encode({
      content: 'deploy window is Friday at 2am',
      kind: 'percept',
      source: 'user',
      explicitFact: true,
      scene: 'working',
    });
    await gate.encode({
      content: 'deploy window is Friday at 3am',
      kind: 'percept',
      source: 'user',
      explicitFact: true,
      scene: 'coding',
    });
    const engine = new ActivationEngine(provider);
    const working = await engine.activate(store, ['deploy window time'], {
      capacity: 2,
      scene: 'working',
      diversityThreshold: 1,
    });
    expect(working.workingSet[0]!.meta?.['scene']).toBe('working');
    const coding = await engine.activate(store, ['deploy window time'], {
      capacity: 2,
      scene: 'coding',
      diversityThreshold: 1,
    });
    expect(coding.workingSet[0]!.meta?.['scene']).toBe('coding');
  });
});

describe('Prospective intentions', () => {
  it('boosts unexpired intentions and demotes them to facts on expiry', async () => {
    const { gate, store, provider, lifecycle, clock } = buildCore();
    const now = clock.now();
    const intention = (await gate.encode({
      content: 'renew the passport before the trip',
      kind: 'intention',
      source: 'user',
      expiresAt: now + 2 * 24 * 60 * 60 * 1000,
    }))!;
    expect(intention.kind).toBe('semantic');
    expect(intention.meta?.['intention']).toBe(true);

    const engine = new ActivationEngine(provider);
    const before = await engine.activate(store, ['passport renewal'], { capacity: 4 });
    expect(before.workingSet[0]!.meta?.['intention']).toBe(true);

    clock.advance(3 * 24 * 60 * 60 * 1000);
    const report = await lifecycle.dream();
    expect(report.notes.join(' ')).toContain('expired intention');
    const after = await store.getNode(intention.id);
    expect(after!.meta?.['intention']).toBe(false);
    // It remains an ordinary fact — expiry is not forgetting.
    const recall = await engine.activate(store, ['passport renewal'], { capacity: 4 });
    expect(recall.workingSet.some((chunk) => chunk.meta?.['nodeId'] === intention.id)).toBe(true);
  });
});
