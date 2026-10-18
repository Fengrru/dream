import { describe, expect, it } from 'vitest';
import { ActivationEngine } from '../src/activation';
import { buildCore } from './helpers';

const DAY = 24 * 60 * 60 * 1000;

describe('Temporal validity', () => {
  it('recalls the version valid at the requested instant', async () => {
    const { gate, store, provider, clock } = buildCore();
    const now = clock.now();
    await gate.encode({
      content: 'The meeting is at 3pm in room A',
      kind: 'percept',
      source: 'user',
      explicitFact: true,
      validUntil: now + DAY,
      confidence: 0.95,
    });
    await gate.encode({
      content: 'The meeting is at 5pm in room B',
      kind: 'percept',
      source: 'user',
      explicitFact: true,
      validFrom: now + DAY,
      confidence: 0.95,
    });

    const engine = new ActivationEngine(provider);
    const before = await engine.activate(store, ['When is the meeting?'], {
      capacity: 4,
      asOf: now + 1,
      diversityThreshold: 1,
    });
    expect(before.workingSet[0]!.content).toContain('3pm');
    expect(before.workingSet.some((chunk) => chunk.content.includes('5pm'))).toBe(false);

    const after = await engine.activate(store, ['When is the meeting?'], {
      capacity: 4,
      asOf: now + 2 * DAY,
      diversityThreshold: 1,
    });
    expect(after.workingSet[0]!.content).toContain('5pm');
    expect(after.workingSet.some((chunk) => chunk.content.includes('3pm'))).toBe(false);
  });

  it('filters by createdAfter', async () => {
    const { gate, store, provider, clock } = buildCore();
    const first = (await gate.encode({
      content: 'old note about the parser',
      kind: 'percept',
      source: 'user',
    }))!;
    clock.advance(1000);
    const second = (await gate.encode({
      content: 'new note about the parser',
      kind: 'percept',
      source: 'user',
    }))!;
    const engine = new ActivationEngine(provider);
    const recent = await engine.activate(store, ['parser note'], {
      capacity: 4,
      createdAfter: second.createdAt,
      diversityThreshold: 1,
    });
    expect(recent.workingSet.map((chunk) => chunk.meta?.['nodeId'])).toEqual([second.id]);
    expect(recent.workingSet.some((chunk) => chunk.meta?.['nodeId'] === first.id)).toBe(false);
  });
});

describe('Evidence and confidence', () => {
  it('counts observations and moves confidence toward new evidence', async () => {
    const { gate, lifecycle, store } = buildCore();
    const node = (await gate.encode({
      content: 'The staging deploy window is Friday at 2am',
      kind: 'percept',
      source: 'user',
      explicitFact: true,
      confidence: 0.2,
    }))!;
    expect(node.evidenceCount).toBe(1);
    for (let i = 0; i < 5; i++) {
      await lifecycle.reinforceMemory(node.id, { confidence: 0.9, reason: 'second source' });
    }
    const after = await store.getNode(node.id);
    expect(after!.evidenceCount).toBe(6);
    expect(after!.confidence).toBeGreaterThan(0.4);
  });

  it('ranks a high-confidence fact above a low-confidence neighbour', async () => {
    const { gate, store, provider } = buildCore();
    await gate.encode({
      content: 'The billing service deploy window is Friday at 2am',
      kind: 'percept',
      source: 'user',
      explicitFact: true,
      confidence: 0.95,
    });
    await gate.encode({
      content: 'The billing service deploy window is Friday at 3am',
      kind: 'percept',
      source: 'user',
      explicitFact: true,
      confidence: 0.2,
    });
    const engine = new ActivationEngine(provider);
    const set = await engine.activate(store, ['billing service deploy window Friday'], {
      capacity: 2,
      diversityThreshold: 1,
    });
    expect(set.workingSet[0]!.content).toContain('2am');
    expect(set.workingSet[0]!.meta?.['confidence']).toBe(0.95);
  });
});
