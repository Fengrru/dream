import { describe, expect, it } from 'vitest';
import { buildCore } from './helpers';
import { bindSkillArgs } from '../src/skills';
import { WorkingMemory } from '../src/working-memory';
import type { TaskTrace } from '../src/types';

/**
 * Regression tests for the issues found in the audit pass. Each test pins a
 * behavior that used to be wrong — do not "simplify" them away.
 */

function trace(taskType: string, steps: Array<{ tool: string; args: unknown }>, percept: string): TaskTrace {
  return { id: `t-${Math.random()}`, taskType, steps, outcome: 'success', ts: 1, percept };
}

describe('audit regressions: skill induction', () => {
  it('does NOT induce a skill from successes with all-different step sequences', async () => {
    const { store, lifecycle } = buildCore();
    for (const steps of [
      [{ tool: 'fetch', args: { a: 1 } }],
      [{ tool: 'search', args: { b: 2 } }],
      [{ tool: 'calc', args: { c: 3 } }],
    ]) {
      await store.appendTrace(trace('mixed-task', steps, 'do the thing'));
    }
    const report = await lifecycle.dream();
    expect(report.skillsFormed).toEqual([]);
  });

  it('still induces a skill when the same sequence repeats the required times', async () => {
    const { store, lifecycle } = buildCore();
    for (let i = 0; i < 3; i++) {
      await store.appendTrace(
        trace('stable-task', [{ tool: 'fetch', args: { q: `q${i}` } }], `run query q${i}`),
      );
    }
    const report = await lifecycle.dream();
    expect(report.skillsFormed).toEqual(['stable-task']);
  });
});

describe('audit regressions: decay vs recency', () => {
  it('decayPass advances the decay reference without touching lastAccessedAt', async () => {
    const { gate, lifecycle, store, clock } = buildCore();
    const node = (await gate.encode({ content: 'visited Rome last spring', kind: 'percept', source: 'user' }))!;
    const accessedBefore = node.lastAccessedAt;
    clock.advance(10 * 60 * 1000);
    await lifecycle.decayPass();
    const stored = await store.getNode(node.id)!;
    expect(stored!.lastDecayedAt).toBe(clock.now());
    expect(stored!.lastAccessedAt).toBe(accessedBefore);
  });

  it('episodic recency ordering survives a dream cycle', async () => {
    const { gate, lifecycle, store, clock, provider } = buildCore();
    // Old, similar episode first; fresh one second.
    await gate.encode({ content: 'trip to Berlin planned for summer', kind: 'percept', source: 'user' });
    clock.advance(30 * 24 * 60 * 60 * 1000);
    await gate.encode({ content: 'trip to Berlin booked for summer', kind: 'percept', source: 'user' });
    await lifecycle.dream(); // includes a decay pass

    const { ActivationEngine } = await import('../src/activation');
    const engine = new ActivationEngine(provider);
    const set = await engine.activate(store, ['the Berlin trip this summer'], {
      capacity: 4,
      excludeSessionId: 'none',
      now: clock.now,
    });
    const contents = set.workingSet.map((c) => c.content);
    const oldIdx = contents.findIndex((c) => c.includes('planned'));
    const newIdx = contents.findIndex((c) => c.includes('booked'));
    expect(oldIdx).toBeGreaterThanOrEqual(0);
    expect(newIdx).toBeGreaterThanOrEqual(0);
    // The fresh episode must outrank the month-old one on recency.
    expect(newIdx).toBeLessThan(oldIdx);
  });
});

describe('audit regressions: activation floors', () => {
  it('an unrelated fresh episode does not enter the working set on recency alone', async () => {
    const { gate, store, provider, clock } = buildCore();
    await gate.encode({
      content: 'completely unrelated note about quantum chemistry bonds',
      kind: 'percept',
      source: 'tool',
    });
    const { ActivationEngine } = await import('../src/activation');
    const engine = new ActivationEngine(provider);
    const set = await engine.activate(store, ['what is my name and where do I live'], {
      capacity: 4,
      now: clock.now,
    });
    expect(set.workingSet).toEqual([]);
  });
});

describe('audit regressions: slot binding', () => {
  it('fails closed when the two anchors are adjacent (empty slot)', () => {
    const meta = {
      strategy: { steps: [{ tool: 'analyze', args: { dataset: 'q4-budget.csv' } }] },
      binding: [{ stepIndex: 0, key: 'dataset', mode: 'slot' as const, before: 'analyze', after: 'now', example: 'q4-budget.csv' }],
    };
    const result = bindSkillArgs(meta, 'analyze now');
    expect(result.ok).toBe(false);
  });

  it('still binds the token between anchors when present', () => {
    const meta = {
      strategy: { steps: [{ tool: 'analyze', args: { dataset: 'q4-budget.csv' } }] },
      binding: [{ stepIndex: 0, key: 'dataset', mode: 'slot' as const, before: 'analyze', after: 'now', example: 'q4-budget.csv' }],
    };
    const result = bindSkillArgs(meta, 'analyze q4-budget.csv now please');
    expect(result.ok).toBe(true);
    expect((result.steps[0]!.args as { dataset: string }).dataset).toBe('q4-budget.csv');
  });
});

describe('audit regressions: working memory tick', () => {
  it('tick() is idempotent at the same instant', () => {
    let t = 1000;
    const wm = new WorkingMemory(4, () => t);
    wm.attend({ content: 'hold this', kind: 'percept', source: 'user' }, 1);
    wm.tick();
    const afterFirst = wm.readAll()[0]!.activation;
    wm.tick();
    wm.tick();
    expect(wm.readAll()[0]!.activation).toBe(afterFirst);
    t += 1000;
    wm.tick();
    expect(wm.readAll()[0]!.activation).toBeLessThan(afterFirst);
  });
});

describe('audit regressions: encoding gate', () => {
  it('rejects empty content instead of storing an unmatchable node', async () => {
    const { gate, store } = buildCore();
    const node = await gate.encode({ content: '   ', kind: 'percept', source: 'user' });
    expect(node).toBeNull();
    expect(await store.listNodes()).toEqual([]);
  });
});
