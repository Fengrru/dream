import { describe, expect, it } from 'vitest';
import { buildCore } from './helpers';
import { ReconsolidationWindowClosedError } from '../src/errors';

describe('Reconsolidation', () => {
  it('recalled memories become writable inside the window and version up', async () => {
    const { gate, lifecycle } = buildCore();
    const node = (await gate.encode({
      content: 'I prefer window seats on flights',
      kind: 'percept',
      source: 'user',
      explicitFact: true,
    }))!;
    await lifecycle.onRecalled([node.id]);

    const updated = await lifecycle.applyUpdate(node.id, {
      content: 'I now prefer aisle seats on flights',
      priority: 'user',
      reason: 'user correction',
    });
    expect(updated.version).toBe(2);
    expect(updated.content).toContain('aisle');
  });

  it('rejects rewrites after the reconsolidation window closes', async () => {
    const { gate, lifecycle, clock } = buildCore();
    const node = (await gate.encode({ content: 'meeting at 3pm', kind: 'percept', source: 'user' }))!;
    // No recall: no labile window was ever opened.
    await expect(
      lifecycle.applyUpdate(node.id, { content: 'meeting at 4pm', priority: 'user', reason: 'correction' }),
    ).rejects.toBeInstanceOf(ReconsolidationWindowClosedError);

    // Recall opens the window; advancing past it closes it again.
    await lifecycle.onRecalled([node.id]);
    clock.advance(11 * 60 * 1000);
    await expect(
      lifecycle.applyUpdate(node.id, { content: 'meeting at 4pm', priority: 'user', reason: 'correction' }),
    ).rejects.toBeInstanceOf(ReconsolidationWindowClosedError);
  });

  it('lower-priority updates are kept as counterpoints, not overwrites', async () => {
    const { gate, lifecycle } = buildCore();
    const node = (await gate.encode({
      content: 'The team uses Python for backend work',
      kind: 'percept',
      source: 'user',
      explicitFact: true,
    }))!;
    await lifecycle.onRecalled([node.id]);
    const updated = await lifecycle.applyUpdate(node.id, {
      content: 'maybe they use Go',
      priority: 'inference',
      reason: 'model guess',
    });
    expect(updated.content).toContain('conflicting note kept');
    expect(updated.content).toContain('Python');
  });
});

describe('Adaptive forgetting', () => {
  it('decays strength; low-importance memories fade faster', async () => {
    const { gate, lifecycle, store, clock } = buildCore();
    const important = (await gate.encode({
      content: 'my daughters birthday is may twelfth',
      kind: 'percept',
      source: 'user',
      explicitFact: true,
    }))!;
    const trivial = (await gate.encode({ content: 'the vending machine was restocked', kind: 'percept', source: 'tool' }))!;

    // Baseline alignment, then one month passes without any recall.
    clock.advance(60 * 60 * 1000);
    await lifecycle.decayPass();
    clock.advance(30 * 24 * 60 * 60 * 1000);
    await lifecycle.decayPass();

    const afterImportant = await store.getNode(important.id);
    const afterTrivial = await store.getNode(trivial.id);
    expect(afterImportant!.strength).toBeGreaterThan(afterTrivial!.strength);
    expect(afterTrivial!.strength).toBeLessThan(0.5);
  });

  it('retrieval practice protects memories from decay', async () => {
    const { gate, lifecycle, store, clock } = buildCore();
    const node = (await gate.encode({ content: 'client call notes about renewal', kind: 'percept', source: 'user' }))!;
    clock.advance(15 * 24 * 60 * 60 * 1000);
    await lifecycle.onRecalled([node.id]); // recalled right before decay
    clock.advance(15 * 24 * 60 * 60 * 1000);
    await lifecycle.decayPass();
    const after = await store.getNode(node.id);
    expect(after!.strength).toBeGreaterThan(0.3);
  });

  it('hard forget removes content but leaves a tombstone in the journal', async () => {
    const { gate, lifecycle, store } = buildCore();
    const node = (await gate.encode({ content: 'secret to be erased', kind: 'percept', source: 'user' }))!;
    const ok = await lifecycle.hardForget(node.id, 'right to erasure');
    expect(ok).toBe(true);
    expect(await store.getNode(node.id)).toBeNull();
    const events = await store.list();
    const purge = events.find((e) => e.type === 'purge');
    expect(purge).toBeDefined();
    expect(purge!.nodeId).toBe(node.id);
    expect(purge!.contentHash).toBeDefined();
    // The journal never stores bodies — only the hash survives.
    const journalDump = JSON.stringify(events);
    expect(journalDump).not.toContain('secret to be erased');
  });
});

describe('Dream cycle (consolidation)', () => {
  it('abstracts a semantic pattern from a cluster of related episodes', async () => {
    const { gate, lifecycle, store } = buildCore();
    for (const content of [
      'analyzed the sales data and found growth in q1',
      'analyzed the sales data and churn rose in q2',
      'analyzed the sales data and margins held in q3',
    ]) {
      await gate.encode({ content, kind: 'percept', source: 'user' });
    }
    const report = await lifecycle.dream();
    expect(report.replayedEpisodes).toBe(3);
    expect(report.abstractions.length).toBe(1);
    const semantic = await store.listNodes({ kinds: ['semantic'] });
    expect(semantic.some((n) => n.content.startsWith('Pattern:') && n.provenance.source === 'dream')).toBe(true);
    // Episodes are marked consolidated and will not be replayed again.
    const second = await lifecycle.dream();
    expect(second.replayedEpisodes).toBe(0);
  });

  it('merges near-duplicate episodes', async () => {
    const { gate, lifecycle } = buildCore();
    await gate.encode({ content: 'standup notes: api latency improved', kind: 'percept', source: 'user' });
    await gate.encode({ content: 'standup notes: api latency improved', kind: 'percept', source: 'user' });
    const report = await lifecycle.dream();
    expect(report.mergedCount).toBe(1);
  });

  it('induces a skill from repeated successful task traces', async () => {
    const { lifecycle, store, clock } = buildCore();
    for (let i = 0; i < 3; i++) {
      await store.appendTrace({
        id: `t${i}`,
        taskType: 'analyze-data',
        steps: [{ tool: 'analyze', args: { dataset: 'sales.csv' } }],
        outcome: 'success',
        ts: clock.now(),
      });
      clock.advance(1000);
    }
    const report = await lifecycle.dream();
    expect(report.skillsFormed).toEqual(['analyze-data']);
    const skills = await store.listNodes({ kinds: ['procedural'] });
    expect(skills.length).toBe(1);
    const meta = skills[0]!.meta as { taskType: string; successRate: number; strategy: { steps: unknown[] } };
    expect(meta.taskType).toBe('analyze-data');
    expect(meta.successRate).toBe(1);
    expect(meta.strategy.steps.length).toBe(1);
  });

  it('updates an existing skill with an EMA of the success rate', async () => {
    const { lifecycle, store, clock } = buildCore();
    for (let i = 0; i < 3; i++) {
      await store.appendTrace({
        id: `s${i}`, taskType: 'analyze-data',
        steps: [{ tool: 'analyze', args: {} }], outcome: 'success', ts: clock.now(),
      });
      clock.advance(1000);
    }
    await lifecycle.dream();
    await store.appendTrace({
      id: 'f0', taskType: 'analyze-data', steps: [{ tool: 'analyze', args: {} }],
      outcome: 'failure', ts: clock.now(),
    });
    clock.advance(1000);
    const report = await lifecycle.dream();
    expect(report.skillsFormed).toEqual([]);
    expect(report.skillsUpdated).toEqual(['analyze-data']);
    const skills = await store.listNodes({ kinds: ['procedural'] });
    const meta = skills[0]!.meta as { successRate: number };
    expect(meta.successRate).toBeCloseTo(0.875); // EMA(1.0, 3/4) with alpha 0.5
  });
});
