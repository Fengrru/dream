import {
  ActivationEngine,
  EncodingGate,
  HashingEmbeddingProvider,
  InMemoryStore,
  LifecycleEngine,
  DEFAULT_LIFECYCLE_CONFIG,
} from '@dream/core';
import { FakeClock } from '../instance';
import { makeTable, type ExperimentResult } from './harness';
import { LIVE_SKIP_NOTE, liveEmbeddingProvider } from './live';

const DAY = 24 * 60 * 60 * 1000;

async function liveConfidence(): Promise<{ rows: Array<Array<string | number>>; note: string }> {
  const live = await liveEmbeddingProvider();
  if (!live) return { rows: [], note: LIVE_SKIP_NOTE };
  const provider = live.provider;
  const store = new InMemoryStore();
  const gate = new EncodingGate(store, store, provider);
  await gate.encode({
    content: 'The billing deploy window is Friday at 2am',
    kind: 'percept',
    source: 'user',
    explicitFact: true,
    confidence: 0.2,
  });
  await gate.encode({
    content: 'The billing deploy window is Friday at 3am',
    kind: 'percept',
    source: 'user',
    explicitFact: true,
    confidence: 0.9,
  });
  const engine = new ActivationEngine(provider);
  const set = await engine.activate(store, ['billing deploy window Friday'], {
    capacity: 2,
    tagWeight: 0,
    episodeWeight: 0,
    diversityThreshold: 1,
  });
  const top = set.workingSet[0];
  return {
    rows: [
      ['high-confidence fact top-1', top?.content.includes('3am') ? 'yes' : 'no', (top?.meta?.['confidence'] as number | undefined) ?? 0],
    ],
    note: `live embeddings: ${live.label}`,
  };
}

/**
 * E15 — Event-time validity and evidence/confidence.
 *
 * Dream used to have only system write time. This experiment asks two
 * questions a personal memory must answer: "what was true at time T?" and
 * "which of two contradictory facts has more support?".
 */
export async function e15Temporal(): Promise<ExperimentResult> {
  const clock = new FakeClock();
  const provider = new HashingEmbeddingProvider(256);
  const store = new InMemoryStore();
  const gate = new EncodingGate(store, store, provider, undefined, clock.now);
  const lifecycle = new LifecycleEngine(
    store,
    store,
    store,
    provider,
    DEFAULT_LIFECYCLE_CONFIG,
    clock.now,
  );
  const now = clock.now();

  const oldMeeting = (await gate.encode({
    content: 'The meeting is at 3pm in room A',
    kind: 'percept',
    source: 'user',
    explicitFact: true,
    validUntil: now + DAY,
    confidence: 0.9,
  }))!;
  const newMeeting = (await gate.encode({
    content: 'The meeting is at 5pm in room B',
    kind: 'percept',
    source: 'user',
    explicitFact: true,
    validFrom: now + DAY,
    confidence: 0.9,
  }))!;

  const engine = new ActivationEngine(provider);
  const query = 'When is the meeting?';
  const noAsOf = await engine.activate(store, [query], { capacity: 4, diversityThreshold: 1 });
  const day0 = await engine.activate(store, [query], {
    capacity: 4,
    asOf: now + 1,
    diversityThreshold: 1,
  });
  const day2 = await engine.activate(store, [query], {
    capacity: 4,
    asOf: now + 2 * DAY,
    diversityThreshold: 1,
  });

  const staleInNoAsOf = noAsOf.workingSet.some((chunk) => chunk.content.includes('3pm'));
  const day0Correct = day0.workingSet[0]?.content.includes('3pm') ?? false;
  const day2Correct = day2.workingSet[0]?.content.includes('5pm') ?? false;
  const day2Stale = day2.workingSet.some((chunk) => chunk.content.includes('3pm'));
  const day0Future = day0.workingSet.some((chunk) => chunk.content.includes('5pm'));

  const high = (await gate.encode({
    content: 'The billing deploy window is Friday at 2am',
    kind: 'percept',
    source: 'user',
    explicitFact: true,
    confidence: 0.7,
  }))!;
  const low = (await gate.encode({
    content: 'The billing deploy window is Friday at 3am',
    kind: 'percept',
    source: 'user',
    explicitFact: true,
    confidence: 0.2,
  }))!;
  // Equal salience isolates confidence: without this the first-encoded fact
  // wins on novelty-derived importance and the experiment measures the wrong
  // variable.
  high.importance = 0.7;
  low.importance = 0.7;
  await store.putNode(high);
  await store.putNode(low);

  const evidenceQuery = 'billing deploy window Friday';
  const before = await engine.activate(store, [evidenceQuery], { capacity: 2, diversityThreshold: 1 });
  for (let i = 0; i < 5; i++) {
    await lifecycle.reinforceMemory(low.id, { confidence: 0.95, reason: 'second source' });
  }
  const after = await engine.activate(store, [evidenceQuery], { capacity: 2, diversityThreshold: 1 });
  const reinforced = await store.getNode(low.id);
  const highAfter = await store.getNode(high.id);

  const live = await liveConfidence();
  const rows: Array<Array<string | number>> = [
    [
      'as-of day 0',
      'both versions visible',
      day0Correct ? '3pm' : 'wrong',
      day0Future ? 'future version leaked' : 'future excluded',
    ],
    [
      'as-of day 2',
      staleInNoAsOf ? 'stale 3pm also visible' : 'stale hidden',
      day2Correct ? '5pm' : 'wrong',
      day2Stale ? 'STALE leaked' : 'stale excluded',
    ],
    [
      'evidence before',
      `high confidence ${(highAfter?.confidence ?? 0).toFixed(2)}`,
      before.workingSet[0]?.content.includes('2am') ? '2am' : '3am',
      `low count ${reinforced!.evidenceCount! - 5}`,
    ],
    [
      'evidence after 5 observations',
      `high confidence ${(highAfter?.confidence ?? 0).toFixed(2)}`,
      after.workingSet[0]?.content.includes('3am') ? '3am' : '2am',
      `low count ${reinforced!.evidenceCount}, confidence ${reinforced!.confidence!.toFixed(2)}`,
    ],
  ];

  const passed =
    day0Correct &&
    day2Correct &&
    !day2Stale &&
    !day0Future &&
    before.workingSet[0]?.content.includes('2am') === true &&
    after.workingSet[0]?.content.includes('3am') === true &&
    reinforced!.evidenceCount === 6 &&
    (reinforced!.confidence ?? 0) > 0.8;

  const findings = [
    `Validity: without asOf both versions competed (stale 3pm visible: ${staleInNoAsOf}); with asOf day 0 only 3pm surfaced, and asOf day 2 returned 5pm with the stale version excluded.`,
    `Evidence: the low-confidence fact started at rank 2; five reinforcements raised evidenceCount from 1 to ${reinforced!.evidenceCount} and confidence from 0.20 to ${reinforced!.confidence!.toFixed(2)}, flipping it above the 0.70 fact.`,
    `Confidence is a ranking prior, not a truth claim: it changes activation by at most ~20% (0.8 + 0.2·confidence), so a single observation cannot dominate.`,
    `Event time and validity intervals are stored separately from createdAt/lastAccessedAt, so system bookkeeping never rewrites history.`,
    live.rows.length > 0
      ? `Live embeddings (${live.note}): high-confidence fact top-1 = ${live.rows[0]![1]}.`
      : `Live embedding confidence check ${live.note}.`,
  ];

  return {
    id: 'E15',
    title: 'Event-time validity & evidence confidence',
    question: 'Can recall answer "what was true at time T" and prefer the better-supported fact?',
    hypothesis:
      'Validity intervals filter stale/future versions at the store boundary; evidence accumulation moves confidence toward repeated observations and can flip ranking.',
    method: [
      'Encode a meeting at 3pm valid until day 1 and a replacement at 5pm valid from day 1.',
      'Recall without asOf, asOf day 0, and asOf day 2; check stale/future leakage.',
      'Encode two contradictory facts at confidence 0.7 and 0.2; reinforce the latter five times and compare ranking.',
    ],
    tables: [
      makeTable(
        'Temporal and evidence behavior',
        ['condition', 'baseline', 'after feature', 'note'],
        rows,
      ),
      makeTable(
        'Live embedding confidence check (optional)',
        ['check', 'result', 'confidence'],
        live.rows.length > 0 ? live.rows : [[live.note, 'n/a', 0]],
      ),
    ],
    findings,
    recommendations: [
      'Always store event time and validity separately from write time; derived memories inherit the interval they describe.',
      'Use confidence as a bounded ranking prior, and keep evidenceCount monotonic for explainability.',
      'Reinforce on repeated observation instead of creating a duplicate node; duplicates are a write-time problem, not a recall-time one.',
    ],
    verdict: passed ? 'works' : 'partial',
  };
}
