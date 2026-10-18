import { describe, expect, it } from 'vitest';
import { buildCore } from './helpers';
import { ReconsolidationWindowClosedError, SupersededMemoryError } from '../src/errors';

describe('Version chain (EVOLVE semantics)', () => {
  it('turns a post-window correction into a new latest version and retires the old one', async () => {
    const { gate, lifecycle, store, clock } = buildCore();
    const original = (await gate.encode({
      content: 'My daughters swim class is at 4pm on Monday',
      kind: 'percept',
      source: 'user',
      explicitFact: true,
    }))!;
    await lifecycle.onRecalled([original.id]);
    clock.advance(24 * 60 * 60 * 1000); // window closed

    // The old in-place path still refuses to rewrite settled history.
    await expect(
      lifecycle.applyUpdate(original.id, {
        content: 'My daughters swim class is at 5pm on Tuesday',
        priority: 'user',
        reason: 'late correction',
      }),
    ).rejects.toBeInstanceOf(ReconsolidationWindowClosedError);

    const evolution = await lifecycle.supersedeMemory(original.id, {
      content: 'My daughters swim class is at 5pm on Tuesday',
      priority: 'user',
      reason: 'late correction',
    });

    expect(evolution.superseded).toBe(true);
    expect(evolution.node.content).toContain('5pm');
    expect(evolution.node.isLatest).toBe(true);
    expect(evolution.node.supersedes).toEqual([original.id]);
    expect(evolution.previous!.isLatest).toBe(false);
    expect(evolution.previous!.supersededBy).toBe(evolution.node.id);

    // Current recall sees only the latest version.
    const current = await store.listNodes();
    expect(current.some((n) => n.id === original.id)).toBe(false);
    expect(current.some((n) => n.id === evolution.node.id)).toBe(true);

    // History keeps both versions, oldest -> newest.
    const chain = await lifecycle.versionChain(original.id);
    expect(chain.map((n) => n.content)).toEqual([
      'My daughters swim class is at 4pm on Monday',
      'My daughters swim class is at 5pm on Tuesday',
    ]);

    const audit = (await store.list()).filter((e) => e.type === 'update' && e.meta?.['action'] === 'supersede');
    expect(audit).toHaveLength(1);
  });

  it('refuses to mutate a record that already has a newer version', async () => {
    const { gate, lifecycle } = buildCore();
    const original = (await gate.encode({
      content: 'The deploy window is Friday at 2am',
      kind: 'percept',
      source: 'user',
      explicitFact: true,
    }))!;
    const { node: latest } = await lifecycle.supersedeMemory(original.id, {
      content: 'The deploy window is Friday at 3am',
      priority: 'user',
      reason: 'correction',
    });

    await expect(
      lifecycle.supersedeMemory(original.id, {
        content: 'The deploy window is Friday at 4am',
        priority: 'user',
        reason: 'second correction',
      }),
    ).rejects.toBeInstanceOf(SupersededMemoryError);

    const second = await lifecycle.supersedeMemory(latest.id, {
      content: 'The deploy window is Friday at 4am',
      priority: 'user',
      reason: 'second correction',
    });
    expect(second.node.version).toBe(3);
    const chain = await lifecycle.versionChain(original.id);
    expect(chain.map((n) => n.content)).toEqual([
      'The deploy window is Friday at 2am',
      'The deploy window is Friday at 3am',
      'The deploy window is Friday at 4am',
    ]);
  });

  it('does not let a weaker source supersede a stronger claim', async () => {
    const { gate, lifecycle } = buildCore();
    const fact = (await gate.encode({
      content: 'The team uses Python for backend work',
      kind: 'percept',
      source: 'user',
      explicitFact: true,
    }))!;
    const result = await lifecycle.supersedeMemory(fact.id, {
      content: 'Maybe the team uses Go',
      priority: 'inference',
      reason: 'model guess',
    });

    expect(result.superseded).toBe(false);
    expect(result.node.id).toBe(fact.id);
    expect(result.node.content).toContain('Python');
    expect(result.node.content).toContain('conflicting note kept');
    expect((await lifecycle.versionChain(fact.id)).length).toBe(1);
  });
});
