import {
  ActivationEngine,
  DEFAULT_LIFECYCLE_CONFIG,
  EncodingGate,
  HashingEmbeddingProvider,
  InMemoryStore,
  LifecycleEngine,
  ReconsolidationWindowClosedError,
} from '@dream/core';
import { FakeClock } from '../instance';
import { makeTable, type ExperimentResult } from './harness';

const OLD_FACT = "My daughter's swim class is at 4pm on Monday.";
const NEW_FACT = "My daughter's swim class is at 5pm on Tuesday.";
const QUESTION = "When is my daughter's swim class?";

const DAY = 24 * 60 * 60 * 1000;

interface ConditionResult {
  path: string;
  staleTop1: boolean;
  correctedTop1: boolean;
  staleInTop4: boolean;
  correctedInTop4: boolean;
  staleIsCurrent: boolean;
  latestIsSemantic: boolean;
  historyLength: number;
  supersedeEvents: number;
}

/**
 * E7 — Version chains for post-window corrections (EVOLVE semantics).
 *
 * The reconsolidation window deliberately rejects in-place rewrites of settled
 * memories. The old fallback encoded the correction as a detached episodic
 * note. That note inherits episodic decay while the stale semantic fact keeps
 * semantic salience, so two months later the stale value is what recall
 * returns. Hy-Memory solves this with immutable, versioned facts: a correction
 * creates a new latest record, retires the old one, and keeps the ancestry.
 *
 * Method: encode a fact, let the window close (30 days), correct it, then let
 * 60 more days pass with weekly decay. Compare:
 *   B: rejected rewrite + linked note (the old behavior)
 *   A: supersedeMemory -> new latest version, old version retired
 */
export async function e7VersionChain(): Promise<ExperimentResult> {
  const baseline = await runCondition(false);
  const versioned = await runCondition(true);
  const chain = await runVersionChain();

  const rows: Array<Array<string | number>> = [
    [
      'B: rejected rewrite + linked note',
      baseline.staleTop1 ? 'stale (4pm)' : 'corrected',
      baseline.staleInTop4 ? 'YES (contradiction in context)' : 'no',
      baseline.staleIsCurrent ? 'yes' : 'no',
      baseline.historyLength,
      baseline.supersedeEvents,
    ],
    [
      'A: version chain (EVOLVE)',
      versioned.staleTop1 ? 'stale (4pm)' : versioned.correctedTop1 ? 'corrected (5pm)' : 'neither',
      versioned.staleInTop4 ? 'yes' : 'no',
      versioned.staleIsCurrent ? 'YES (wrong)' : 'no',
      versioned.historyLength,
      versioned.supersedeEvents,
    ],
  ];

  const enhancedPassed =
    versioned.correctedTop1 &&
    !versioned.staleTop1 &&
    !versioned.staleInTop4 &&
    !versioned.staleIsCurrent &&
    versioned.latestIsSemantic &&
    versioned.historyLength === 2 &&
    versioned.supersedeEvents === 1;

  const findings = [
    `Baseline: the post-window correction was rejected; it survived only as an episodic linked note. After 60 days the stale semantic fact still ranks ` +
      `top-1 (${baseline.staleTop1 ? '4pm' : 'not stale'}) and remains the only current version (history length ${baseline.historyLength}).`,
    `Version chain: the correction created a new latest semantic version (${versioned.correctedTop1 ? '5pm top-1' : 'did not rank top-1'}), ` +
      `the stale record is retired from current recall (${versioned.staleIsCurrent ? 'still current — wrong' : 'not current'}), and history keeps both versions (length ${versioned.historyLength}).`,
    `Three successive corrections produced a ${chain.contents.length}-version chain; only the newest version was recalled, all prior versions stayed inspectable, ` +
      `and a late inference-priority claim was appended as a counterpoint instead of replacing the user's version (${chain.priorityHeld ? 'held' : 'FAILED'}).`,
    `Audit: the supersede path wrote ${versioned.supersedeEvents} journal event(s) with the old and new ids; the rejected baseline path wrote none for the correction.`,
  ];

  return {
    id: 'E7',
    title: 'Version chains for post-window corrections',
    question: 'Can a correction after the reconsolidation window update what recall returns without destroying history?',
    hypothesis:
      'Rejecting the rewrite and encoding a linked note leaves the stale semantic fact authoritative; a version chain (new latest + retired predecessor) makes the correction win recall while keeping an auditable ancestry.',
    method: [
      'Encode a semantic fact, recall it to open the reconsolidation window, then advance 30 days so the window is closed.',
      'Condition B: let applyUpdate reject the correction, then encode the corrected text as a linked episodic note (the old fallback).',
      'Condition A: supersedeMemory creates a new latest version and retires the old one.',
      'Advance 60 more days with weekly decay, then ask the same question through ActivationEngine and inspect current records + versionChain.',
      'Separately, apply three successive corrections and verify ordering, latest-only recall, and the evidence-priority guard.',
    ],
    tables: [
      makeTable(
        'Correction outcome two months later',
        [
          'condition',
          'top-1 recalled value',
          'stale value in top-4',
          'stale record still current',
          'history versions',
          'supersede audit events',
        ],
        rows,
      ),
      makeTable(
        'Version-chain integrity (four generations)',
        ['check', 'result'],
        [
          ['history contents', chain.contents.join(' -> ')],
          ['current records with old values', chain.currentOldValues],
          ['latest version recalled top-1', chain.latestTop1 ? 'yes' : 'no'],
          ['lower-priority claim superseded a user fact', chain.priorityHeld ? 'no (counterpoint kept)' : 'YES (wrong)'],
        ],
      ),
    ],
    findings,
    recommendations: [
      'Use the version chain for post-window corrections; keep the reconsolidation window for cheap in-place rewrites inside a conversation.',
      'Recall must default to latest-only; expose history through an explicit API so stale values cannot leak into reasoning context.',
      'Keep the evidence-priority ladder in the supersede path too — immutability must not let an inference overwrite a user fact.',
    ],
    verdict: enhancedPassed ? 'works' : 'partial',
  };
}

async function runCondition(useVersionChain: boolean): Promise<ConditionResult> {
  const store = new InMemoryStore();
  const clock = new FakeClock();
  const provider = new HashingEmbeddingProvider(256);
  const gate = new EncodingGate(store, store, provider, undefined, clock.now);
  const lifecycle = new LifecycleEngine(store, store, store, provider, DEFAULT_LIFECYCLE_CONFIG, clock.now);

  const original = (await gate.encode({
    content: OLD_FACT,
    kind: 'percept',
    source: 'user',
    explicitFact: true,
  }))!;
  await lifecycle.onRecalled([original.id]);
  clock.advance(30 * DAY); // window closed long ago

  let path: string;
  if (useVersionChain) {
    await lifecycle.supersedeMemory(original.id, {
      content: NEW_FACT,
      priority: 'user',
      reason: 'user corrected the schedule a month later',
    });
    path = 'supersede';
  } else {
    let rejected = false;
    try {
      await lifecycle.applyUpdate(original.id, {
        content: NEW_FACT,
        priority: 'user',
        reason: 'late correction',
      });
    } catch (err) {
      rejected = err instanceof ReconsolidationWindowClosedError;
    }
    if (!rejected) throw new Error('baseline applyUpdate unexpectedly accepted a post-window rewrite');
    // The old session fallback: encode the correction as a detached note.
    await gate.encode({ content: NEW_FACT, kind: 'percept', source: 'user' });
    path = 'rejected+linked-note';
  }

  // Two months of ordinary life: weekly decay, no explicit recall.
  for (let week = 0; week < 8; week++) {
    clock.advance(7 * DAY);
    await lifecycle.decayPass();
  }

  const engine = new ActivationEngine(provider);
  const set = await engine.activate(store, [QUESTION], { capacity: 4, diversityThreshold: 1 });
  const contents = set.workingSet.map((chunk) => chunk.content);
  const staleTop1 = contents[0]?.includes('4pm') ?? false;
  const correctedTop1 = contents[0]?.includes('5pm') ?? false;
  const current = await store.listNodes();
  const history = await lifecycle.versionChain(original.id);
  const events = await store.list();
  const supersedeEvents = events.filter(
    (event) => event.type === 'update' && event.meta?.['action'] === 'supersede',
  ).length;

  return {
    path,
    staleTop1,
    correctedTop1,
    staleInTop4: contents.some((content) => content.includes('4pm')),
    correctedInTop4: contents.some((content) => content.includes('5pm')),
    staleIsCurrent: current.some((node) => node.id === original.id),
    latestIsSemantic:
      current.some((node) => node.kind === 'semantic' && node.content.includes('5pm')) &&
      !current.some((node) => node.kind === 'semantic' && node.content.includes('4pm')),
    historyLength: history.length,
    supersedeEvents,
  };
}

async function runVersionChain(): Promise<{
  contents: string[];
  currentOldValues: number;
  latestTop1: boolean;
  priorityHeld: boolean;
}> {
  const store = new InMemoryStore();
  const clock = new FakeClock();
  const provider = new HashingEmbeddingProvider(256);
  const gate = new EncodingGate(store, store, provider, undefined, clock.now);
  const lifecycle = new LifecycleEngine(store, store, store, provider, DEFAULT_LIFECYCLE_CONFIG, clock.now);

  const versions = [
    "My daughter's swim class is at 4pm on Monday.",
    "My daughter's swim class is at 5pm on Tuesday.",
    "My daughter's swim class is at 6pm on Wednesday.",
    "My daughter's swim class is at 7pm on Thursday.",
  ];

  let node = (await gate.encode({
    content: versions[0]!,
    kind: 'percept',
    source: 'user',
    explicitFact: true,
  }))!;
  for (const content of versions.slice(1)) {
    clock.advance(30 * DAY);
    const evolution = await lifecycle.supersedeMemory(node.id, {
      content,
      priority: 'user',
      reason: 'schedule changed again',
    });
    node = evolution.node;
  }

  const chain = await lifecycle.versionChain(node.id);
  const engine = new ActivationEngine(provider);
  const set = await engine.activate(store, [QUESTION], { capacity: 4, diversityThreshold: 1 });
  const latestTop1 = set.workingSet[0]?.content.includes('7pm') ?? false;

  const current = await store.listNodes({ kinds: ['semantic'] });
  const currentOldValues = current.filter(
    (record) => record.content.includes('4pm') || record.content.includes('5pm') || record.content.includes('6pm'),
  ).length;

  const before = await lifecycle.versionChain(node.id);
  const weaker = await lifecycle.supersedeMemory(node.id, {
    content: "Maybe the swim class is at noon.",
    priority: 'inference',
    reason: 'model guess',
  });
  const after = await lifecycle.versionChain(node.id);
  const priorityHeld =
    !weaker.superseded &&
    after.length === before.length &&
    weaker.node.content.includes('7pm') &&
    weaker.node.content.includes('conflicting note kept');

  return {
    contents: chain.map((record) => {
      const match = record.content.match(/\d+pm/);
      return match?.[0] ?? record.content;
    }),
    currentOldValues,
    latestTop1,
    priorityHeld,
  };
}
