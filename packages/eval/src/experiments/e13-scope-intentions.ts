import {
  ActivationEngine,
  EncodingGate,
  HashingEmbeddingProvider,
  InMemoryStore,
} from '@dream/core';
import { QueryRewritePlugin } from '@dream/plugin-query-rewrite';
import { FakeClock, createInstance } from '../instance';
import { makeTable, pct, type ExperimentResult } from './harness';

async function ownerIsolation(): Promise<{ baselineForeign: number; isolatedForeign: number }> {
  const provider = new HashingEmbeddingProvider(256);
  const store = new InMemoryStore();
  const gate = new EncodingGate(store, store, provider);
  const users = ['alice', 'bob', 'carol'];
  for (const user of users) {
    for (let i = 0; i < 10; i++) {
      await gate.encode(
        {
          content: `User ${user} prefers notification method ${user}-${i} for alerts.`,
          kind: 'percept',
          source: 'user',
          explicitFact: true,
        },
        { userId: user },
      );
    }
  }
  const engine = new ActivationEngine(provider);
  let baselineForeign = 0;
  let isolatedForeign = 0;
  for (const user of users) {
    const query = 'Which notification method does the user prefer?';
    const baseline = await engine.activate(store, [query], { capacity: 4 });
    const isolated = await engine.activate(store, [query], { capacity: 4, userId: user });
    baselineForeign += baseline.workingSet.filter((chunk) => chunk.meta?.['userId'] !== user).length;
    isolatedForeign += isolated.workingSet.filter((chunk) => chunk.meta?.['userId'] !== user).length;
  }
  return { baselineForeign: baselineForeign / users.length, isolatedForeign: isolatedForeign / users.length };
}

async function scenePrior(): Promise<{ baseline: number; enhanced: number; total: number }> {
  const provider = new HashingEmbeddingProvider(256);
  const store = new InMemoryStore();
  const gate = new EncodingGate(store, store, provider);
  for (let i = 0; i < 10; i++) {
    const content = `The deploy window for service svc${i} is at ${i + 1}am UTC.`;
    await gate.encode({ content, kind: 'percept', source: 'user', explicitFact: true, scene: 'working' });
    await gate.encode({ content, kind: 'percept', source: 'user', explicitFact: true, scene: 'coding' });
  }
  const engine = new ActivationEngine(provider);
  let baseline = 0;
  let enhanced = 0;
  let total = 0;
  for (let i = 0; i < 10; i++) {
    const query = `deploy window for service svc${i}`;
    const scene = i % 2 === 0 ? 'working' : 'coding';
    const without = await engine.activate(store, [query], { capacity: 2, diversityThreshold: 1 });
    const withScene = await engine.activate(store, [query], {
      capacity: 2,
      scene,
      diversityThreshold: 1,
    });
    total++;
    if (without.workingSet[0]?.meta?.['scene'] === scene) baseline++;
    if (withScene.workingSet[0]?.meta?.['scene'] === scene) enhanced++;
  }
  return { baseline, enhanced, total };
}

interface IntentionResult {
  targetTop1Before: number;
  targetTop4Before: number;
  intentionTop1Before: number;
  intentionTop1After: number;
  targetRecallableAfter: number;
  expiredNotes: string;
}

async function intentions(): Promise<IntentionResult> {
  const provider = new HashingEmbeddingProvider(256);
  const store = new InMemoryStore();
  const clock = new FakeClock();
  const gate = new EncodingGate(store, store, provider, undefined, clock.now);
  // Construct the lifecycle via a kernel-free import to keep this scenario focused.
  const { LifecycleEngine, DEFAULT_LIFECYCLE_CONFIG } = await import('@dream/core');
  const lifecycle = new LifecycleEngine(
    store,
    store,
    store,
    provider,
    DEFAULT_LIFECYCLE_CONFIG,
    clock.now,
  );
  const engine = new ActivationEngine(provider);

  const targets: string[] = [];
  for (let i = 0; i < 5; i++) {
    const node = (await gate.encode({
      content: `renew passport ${i} before the trip`,
      kind: 'intention',
      source: 'user',
      expiresAt: clock.now() + 2 * 24 * 60 * 60 * 1000,
    }))!;
    targets.push(node.id);
    await gate.encode({
      content: `renew travel insurance ${i} before the trip`,
      kind: 'percept',
      source: 'user',
      explicitFact: true,
    });
  }

  let targetTop1Before = 0;
  let targetTop4Before = 0;
  let intentionTop1Before = 0;
  for (let i = 0; i < 5; i++) {
    const set = await engine.activate(store, [`passport renewal ${i}`], { capacity: 4 });
    const top = set.workingSet[0];
    if (top?.meta?.['nodeId'] === targets[i]) targetTop1Before++;
    if (set.workingSet.some((chunk) => chunk.meta?.['nodeId'] === targets[i])) targetTop4Before++;
    if (top?.meta?.['intention'] === true) intentionTop1Before++;
  }

  clock.advance(3 * 24 * 60 * 60 * 1000);
  const report = await lifecycle.dream();
  let intentionTop1After = 0;
  let targetRecallableAfter = 0;
  for (let i = 0; i < 5; i++) {
    const set = await engine.activate(store, [`passport renewal ${i}`], { capacity: 4 });
    if (set.workingSet[0]?.meta?.['intention'] === true) intentionTop1After++;
    if (set.workingSet.some((chunk) => chunk.meta?.['nodeId'] === targets[i])) targetRecallableAfter++;
  }

  return {
    targetTop1Before,
    targetTop4Before,
    intentionTop1Before,
    intentionTop1After,
    targetRecallableAfter,
    expiredNotes: report.notes.join(' '),
  };
}

async function queryRewrite(): Promise<{ baseline: string; enhanced: string }> {
  const run = async (withPlugin: boolean): Promise<string> => {
    const { kernel } = await createInstance({ retrievalDiversityThreshold: 1 });
    if (withPlugin) await kernel.use(new QueryRewritePlugin());
    for (const content of [
      'The billing service release schedule is Friday at 2am UTC.',
      'The staging deploy window is Monday at 9am UTC.',
      'The payroll service release schedule is Tuesday at 4am UTC.',
    ]) {
      await kernel.encodeChunk({
        content,
        kind: 'percept',
        source: 'user',
        explicitFact: true,
      });
    }
    const recall = await kernel.recallContext('When is the billing service deploy window?');
    return recall.nodes[0]?.content ?? '';
  };
  return { baseline: await run(false), enhanced: await run(true) };
}

/**
 * E13 — Owner isolation, scene priors, intentions, query rewrite.
 *
 * Four P4 capabilities that must not fragment the unified memory space:
 * owner partitions, scene boosting, prospective intentions with expiry, and
 * deterministic query expansion.
 */
export async function e13ScopeIntentions(): Promise<ExperimentResult> {
  const owners = await ownerIsolation();
  const scenes = await scenePrior();
  const plans = await intentions();
  const rewrite = await queryRewrite();

  const rows: Array<Array<string | number>> = [
    [
      'owner isolation (top-4 foreign items)',
      owners.baselineForeign,
      owners.isolatedForeign,
      'unfiltered vs userId filter',
    ],
    [
      'scene prior (top-1 matches requested scene)',
      `${scenes.baseline}/${scenes.total}`,
      `${scenes.enhanced}/${scenes.total}`,
      'unified store, boost only',
    ],
    [
      'intention before expiry (target top-1)',
      `${plans.targetTop1Before}/5`,
      `${plans.intentionTop1Before}/5 top-1 are intentions`,
      `target in top-4: ${plans.targetTop4Before}/5`,
    ],
    [
      'intention after expiry',
      '—',
      `${plans.intentionTop1After}/5 proactive; ${plans.targetRecallableAfter}/5 still recallable`,
      plans.expiredNotes,
    ],
    [
      'query rewrite (top-1 answer)',
      rewrite.baseline.slice(0, 46),
      rewrite.enhanced.slice(0, 46),
      'deploy window -> release schedule',
    ],
  ];

  const ownersPassed = owners.isolatedForeign === 0 && owners.baselineForeign > 0;
  const scenesPassed = scenes.enhanced > scenes.baseline;
  const intentionsPassed =
    plans.targetTop4Before === 5 &&
    plans.intentionTop1Before >= 4 &&
    plans.intentionTop1After === 0 &&
    plans.targetRecallableAfter === 5;
  const rewritePassed = rewrite.baseline.includes('staging') && rewrite.enhanced.includes('release schedule');

  const findings = [
    `Owner isolation: unfiltered recall exposed ${pct(owners.baselineForeign / 4)}% foreign slots on average; the userId filter reduced that to ${owners.isolatedForeign}.`,
    `Scene prior: a matching scene raised top-1 accuracy from ${scenes.baseline}/${scenes.total} to ${scenes.enhanced}/${scenes.total} without splitting the store.`,
    `Intentions: ${plans.intentionTop1Before}/5 queries surfaced an unexpired intention at rank 1; after expiry, ${plans.intentionTop1After}/5 were still proactive but ${plans.targetRecallableAfter}/5 remained recallable as ordinary facts (${plans.expiredNotes}).`,
    `Query rewrite: the baseline returned "${rewrite.baseline.slice(0, 46)}" while the plugin returned "${rewrite.enhanced.slice(0, 46)}".`,
  ];

  return {
    id: 'E13',
    title: 'Owner isolation, scene priors, intentions & query rewrite',
    question: 'Can P4 capabilities work without fragmenting the unified memory space?',
    hypothesis:
      'Owner filtering, scene boosting, intention expiry and deterministic query expansion each improve their scenario while keeping one store and four memory kinds.',
    method: [
      'Encode 10 facts each for three users; compare unfiltered vs userId-filtered recall for foreign slots.',
      'Encode the same facts tagged working/coding; compare top-1 scene match with and without the scene prior.',
      'Encode five intentions with a 2-day expiry; measure top-1 before expiry, then dream and measure proactive vs ordinary recall.',
      'Compare recall for "deploy window" with and without the deterministic query rewrite plugin.',
    ],
    tables: [
      makeTable(
        'P4 capabilities',
        ['scenario', 'without feature', 'with feature', 'note'],
        rows,
      ),
    ],
    findings,
    recommendations: [
      'Filter every read path by userId, including lexical and spreading activation — a single unfiltered channel leaks.',
      'Keep scenes as priors, not partitions: one store, four kinds, a boost.',
      'Expire intentions into ordinary facts; do not forget them just because the reminder fired.',
      'Keep query rewrite deterministic and optional; an LLM rewriter belongs in a plugin with an offline fallback.',
    ],
    verdict:
      ownersPassed && scenesPassed && intentionsPassed && rewritePassed ? 'works' : 'partial',
  };
}
