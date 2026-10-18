import { describe, expect, it } from 'vitest';
import { buildKernel } from './fixtures';
import { behaviors } from '@dream/plugin-scripted';

describe('Session executive', () => {
  it('runs a tool turn end-to-end and records a task trace', async () => {
    const { kernel, scripted, store } = await buildKernel();
    scripted.set(behaviors.toolThenAnswer('weather', { city: 'Tokyo' }, 'Tokyo is sunny today.'));
    const session = kernel.session();
    await session.start();
    const turn = await session.submit('what is the weather in Tokyo?');

    expect(turn.final).toBe('Tokyo is sunny today.');
    expect(turn.toolResults.length).toBe(1);
    expect(String(turn.toolResults[0])).toContain('sunny');
    expect(turn.reasoningCalls).toBe(2);

    const traces = await store.listTraces();
    expect(traces.length).toBe(1);
    expect(traces[0]!.taskType).toBe('unclassified');
    expect(traces[0]!.steps[0]!.tool).toBe('weather');
    expect(traces[0]!.outcome).toBe('success');
  });

  it('survives across sessions: a fact from session one is recalled in session two', async () => {
    const { kernel, scripted } = await buildKernel();

    // Session one: the user states a stable fact.
    scripted.set(behaviors.answer('Noted.'));
    const s1 = kernel.session();
    await s1.start();
    await s1.submit('My sisters name is Ada', { explicitFact: true });
    await s1.end();

    // Session two: a fresh activation pattern over the same memory space.
    scripted.set(behaviors.recallEcho());
    const s2 = kernel.session();
    await s2.start();
    const turn = await s2.submit('What is my sisters name?');

    expect(turn.recalled.length).toBeGreaterThan(0);
    expect(turn.final).toContain('Ada');
  });

  it('routes a post-window correction through the version chain', async () => {
    const { kernel, scripted, store } = await buildKernel();

    scripted.set(behaviors.answer('Noted.'));
    const s1 = kernel.session();
    await s1.submit('My swim class is at 4pm on Monday', { explicitFact: true });
    await s1.end();

    const [original] = await store.listNodes({ kinds: ['semantic'] });
    expect(original).toBeDefined();

    // No recall in this session: the record is not labile, so applyUpdate
    // would throw — the executive must supersede instead of dropping a note.
    scripted.set(async () => ({
      kind: 'correct',
      nodeId: original!.id,
      content: 'My swim class is at 5pm on Tuesday',
      priority: 'user',
      reason: 'user correction',
    }));
    const s2 = kernel.session();
    const turn = await s2.submit('Actually my swim class moved');
    expect(turn.final).toContain('Memory superseded');

    const current = await store.listNodes({ kinds: ['semantic'] });
    expect(current).toHaveLength(1);
    expect(current[0]!.content).toContain('5pm');
    const history = await kernel.memoryHistory(original!.id);
    expect(history.map((node) => node.content)).toEqual([
      'My swim class is at 4pm on Monday',
      'My swim class is at 5pm on Tuesday',
    ]);
  });

  it('fails closed when a skill is replayed outside its learned environment', async () => {
    const { kernel, scripted, clock } = await buildKernel();
    scripted.set(behaviors.toolThenAnswer('analyze', { dataset: 'sales.csv' }, 'analysis done'));
    for (let i = 0; i < 3; i++) {
      const s = kernel.session();
      await s.submit(`analyze sales.csv run ${i}`, {
        taskType: 'analyze-data',
        environment: 'staging',
      });
      await s.end();
      clock.advance(60_000);
    }
    await kernel.dreamNow();

    const production = kernel.session();
    const wrongEnv = await production.submit('analyze sales.csv run 4', {
      taskType: 'analyze-data',
      environment: 'production',
    });
    expect(wrongEnv.skillUsed).toBeNull();
    expect(wrongEnv.reasoningCalls).toBeGreaterThan(0);

    const staging = kernel.session();
    const rightEnv = await staging.submit('analyze sales.csv run 5', {
      taskType: 'analyze-data',
      environment: 'staging',
    });
    expect(rightEnv.skillUsed).toBe('analyze-data');
    expect(rightEnv.reasoningCalls).toBe(0);
  });

  it('matches skills through mined search keys when no task type is given', async () => {
    const learn = async (config?: Record<string, unknown>) => {
      const rig = await buildKernel({ config });
      rig.scripted.set(behaviors.toolThenAnswer('analyze', { dataset: 'sales.csv' }, 'analysis done'));
      for (let i = 0; i < 3; i++) {
        const s = rig.kernel.session();
        await s.submit(`analyze sales.csv run ${i}`, { taskType: 'analyze-data' });
        await s.end();
        rig.clock.advance(60_000);
      }
      await rig.kernel.dreamNow();
      const s = rig.kernel.session();
      const turn = await s.submit('analyze sales figures please');
      return turn;
    };

    const baseline = await learn({ useSkillSearchKeys: false, skillSimilarityThreshold: 0.45 });
    const enhanced = await learn({ useSkillSearchKeys: true, skillSimilarityThreshold: 0.45 });
    expect(baseline.skillUsed).toBeNull();
    expect(enhanced.skillUsed).toBe('analyze-data');
  });

  it('returns verbatim details with a recalled summarized fact', async () => {
    const { kernel, scripted } = await buildKernel();
    scripted.set(behaviors.answer('Noted.'));
    const s1 = kernel.session();
    await s1.submit('The storage locker combination is 4821', {
      explicitFact: true,
      details: 'Locker 12, code 4821, access 6am-10pm',
    });
    await s1.end();

    scripted.set(behaviors.recallEcho());
    const s2 = kernel.session();
    const turn = await s2.submit('What is the locker combination?');
    expect(turn.recalled.length).toBeGreaterThan(0);
    expect(turn.recalled[0]!.details).toContain('4821');
  });

  it('stops repetitive tool loops deterministically', async () => {
    const { kernel, scripted, store } = await buildKernel();
    scripted.set(behaviors.sameToolForever('weather', { city: 'Tokyo' }));
    const session = kernel.session();
    const turn = await session.submit('loop me');
    expect(turn.final).toContain('[SYSTEM]');
    expect(turn.final).toContain('loop');
    const traces = await store.listTraces();
    expect(traces[0]!.outcome).toBe('failure');
  });

  it('enforces the per-turn step budget', async () => {
    const { kernel, scripted } = await buildKernel({ config: { maxStepsPerTurn: 3 } });
    scripted.set(behaviors.uniqueToolForever('weather'));
    const session = kernel.session();
    const turn = await session.submit('budget test');
    expect(turn.final).toContain('budget exhausted');
  });

  it('executes a learned skill implicitly, without calling the reasoning strategy', async () => {
    const { kernel, scripted, store, clock } = await buildKernel();

    // Learn: three successful 'analyze-data' executions with identical steps.
    scripted.set(behaviors.toolThenAnswer('analyze', { dataset: 'sales.csv' }, 'analysis done'));
    for (let i = 0; i < 3; i++) {
      const s = kernel.session();
      await s.start();
      await s.submit(`analyze sales.csv run ${i}`, { taskType: 'analyze-data' });
      await s.end();
      clock.advance(60_000);
    }
    const report = await kernel.dreamNow();
    expect(report.skillsFormed).toContain('analyze-data');
    const callsAfterLearning = scripted.calls;

    // Use: the same task type now runs implicitly — zero reasoning calls.
    scripted.set(behaviors.answer('should never be reached'));
    const s2 = kernel.session();
    const turn = await s2.submit('analyze sales.csv again please', { taskType: 'analyze-data' });

    expect(turn.skillUsed).toBe('analyze-data');
    expect(scripted.calls).toBe(callsAfterLearning);
    expect(turn.final).toContain('learned skill');
    expect(String(turn.toolResults[0])).toContain('sales.csv');

    const traces = await store.listTraces('analyze-data');
    expect(traces.length).toBe(4); // 3 explicit + 1 implicit
  });

  it('binds skill parameters from the request instead of replaying stale args', async () => {
    const { kernel, scripted, store, clock } = await buildKernel();

    // Learn analyze-data on sales.csv (percepts recorded for slot mining).
    scripted.set(behaviors.toolThenAnswer('analyze', { dataset: 'sales.csv' }, 'analysis done'));
    for (let i = 0; i < 3; i++) {
      const s = kernel.session();
      await s.submit(`analyze sales.csv (run ${i + 1})`, { taskType: 'analyze-data' });
      await s.end();
      clock.advance(60_000);
    }
    await kernel.dreamNow();
    const callsBeforeUse = scripted.calls;

    // Drift: same task type, DIFFERENT dataset — the slot must refill.
    const s2 = kernel.session();
    const driftTurn = await s2.submit('analyze q4-budget.csv now', { taskType: 'analyze-data' });

    expect(driftTurn.skillUsed).toBe('analyze-data');
    expect(String(driftTurn.toolResults[0])).toContain('q4-budget.csv');
    expect(String(driftTurn.toolResults[0])).not.toContain('sales.csv');
    expect(scripted.calls).toBe(callsBeforeUse); // still zero reasoning calls

    // No-anchor request: binding fails closed -> explicit reasoning, no skill.
    // The scripted fallback emits its own (correct) tool call on the first
    // reasoning call of this run, then finalizes.
    let armed = false;
    scripted.set(async () => {
      if (!armed) {
        armed = true;
        return { kind: 'tool_calls', calls: [{ name: 'analyze', args: { dataset: 'sales.csv' } }] };
      }
      return { kind: 'final', content: 'analysis done via explicit reasoning' };
    });
    const s3 = kernel.session();
    const fallbackTurn = await s3.submit('run the usual analysis', { taskType: 'analyze-data' });
    expect(fallbackTurn.skillUsed).toBeNull();
    expect(String(fallbackTurn.toolResults[0])).toContain('sales.csv');
    expect(scripted.calls).toBe(callsBeforeUse + 2); // explicit reasoning handled it

    // The drift trace records what actually executed.
    const traces = await store.listTraces('analyze-data');
    const driftTrace = traces.find((t) => JSON.stringify(t.steps).includes('q4-budget.csv'));
    expect(driftTrace).toBeDefined();
    expect(driftTrace!.percept).toContain('q4-budget.csv');
  });

  it('applies a user correction through the reconsolidation window', async () => {
    const { kernel, scripted, store } = await buildKernel();

    scripted.set(behaviors.answer('Noted.'));
    const s1 = kernel.session();
    await s1.submit('I prefer window seats on flights', { explicitFact: true });
    await s1.end();

    scripted.set(behaviors.recallEcho());
    const s2 = kernel.session();
    await s2.submit('What seat do I prefer on flights?');
    expect(s2).toBeDefined();

    // The user corrects themselves right after recall (memory is labile now).
    // The reasoning layer targets the semantic memory that actually contradicts.
    scripted.set(
      behaviors.correctWhere((n) => n.kind === 'semantic', 'I now prefer aisle seats on flights'),
    );
    const s3 = kernel.session();
    await s3.start({ contextSeeds: ['flight seat preference'] });
    const turn = await s3.submit('Actually I now prefer aisle seats');

    expect(turn.final).toContain('Memory updated');

    const semantic = await store.listNodes({ kinds: ['semantic'] });
    const seat = semantic.find((n) => n.content.includes('seats'));
    expect(seat!.version).toBe(2);
    expect(seat!.content).toContain('aisle');
  });
});
