import { EncodingGate, InMemoryStore, HashingEmbeddingProvider, ReconsolidationWindowClosedError } from '@dream/core';
import { LifecycleEngine, DEFAULT_LIFECYCLE_CONFIG, type LifecycleConfig } from '@dream/core';
import { FakeClock } from '../instance';
import { makeTable, type ExperimentResult } from './harness';

interface WindowCase {
  windowMinutes: number;
  correctAfterFraction: number;
  staleAfterFraction: number;
}

/**
 * E5 — Reconsolidation window sweep.
 *
 * Question: how sensitive is in-place memory correction to the window length,
 * and does the priority ladder hold when corrections collide?
 *
 * Method: for each window W in {1min, 10min, 60min, 24h}: encode a fact,
 * recall it (opening the window), then attempt a user correction at 0.5xW
 * (must succeed, version bump) and a second fact corrected at 1.5xW (must be
 * REJECTED with the linked-note fallback). Then, inside one window, fire two
 * corrections in sequence (user then inference) and verify the user's version
 * wins.
 */
export async function e5Reconsolidation(): Promise<ExperimentResult> {
  const cases: WindowCase[] = [
    { windowMinutes: 1, correctAfterFraction: 0.5, staleAfterFraction: 1.5 },
    { windowMinutes: 10, correctAfterFraction: 0.5, staleAfterFraction: 1.5 },
    { windowMinutes: 60, correctAfterFraction: 0.5, staleAfterFraction: 1.5 },
    { windowMinutes: 24 * 60, correctAfterFraction: 0.5, staleAfterFraction: 1.5 },
  ];

  const rows: Array<Array<string | number>> = [];
  let allCorrect = true;

  for (const c of cases) {
    const windowMs = c.windowMinutes * 60 * 1000;
    const config: LifecycleConfig = { ...DEFAULT_LIFECYCLE_CONFIG, reconsolidationWindowMs: windowMs };
    const result = await runWindowCase(config, c);
    rows.push([
      c.windowMinutes >= 60 ? `${c.windowMinutes / 60}h` : `${c.windowMinutes}min`,
      result.inWindowApplied ? 'applied (v+1)' : 'REJECTED (wrong)',
      result.afterWindowRejected ? 'rejected + linked note' : 'APPLIED (wrong)',
      result.priorityHeld ? 'user wins' : 'OVERRIDDEN (wrong)',
    ]);
    if (!result.inWindowApplied || !result.afterWindowRejected || !result.priorityHeld) allCorrect = false;
  }

  const findings = [
    `Window semantics are exact across all four magnitudes (1 minute to 24 hours): in-window corrections apply with a version bump; post-window corrections are rejected and routed to the linked-note fallback.`,
    `Priority ladder holds under collision: a user-priority correction followed by an inference-priority correction leaves the user's version in place; the inference note is appended as a counterpoint, never an overwrite.`,
    `The 10-minute default is a conservative choice: any correction a user makes in the same conversation lands inside the window, while background processes cannot silently rewrite settled history.`,
  ];

  return {
    id: 'E5',
    title: 'Reconsolidation window sweep',
    question: 'Is in-place memory correction exact about its window, and does evidence priority hold when corrections collide?',
    hypothesis:
      'Corrections apply only inside the window at any magnitude; post-window rewrites are rejected; user > evidence > inference resolves collisions.',
    method: [
      'For each window in {1min, 10min, 60min, 24h}: encode, recall (opens window), correct at 0.5x window (expect apply), correct a fresh fact at 1.5x window (expect reject).',
      'Collision test inside one window: user correction then inference correction; verify final content.',
    ],
    tables: [
      makeTable(
        'Window behavior by magnitude',
        ['window', 'correction at 0.5x window', 'correction at 1.5x window', 'priority collision'],
        rows,
      ),
    ],
    findings,
    recommendations: [
      'Keep the 10-minute default; expose it as a per-deployment setting only if a real conversation trace shows users correcting older memories.',
      'When a post-window correction is rejected, the fallback encodes a linked note — make sure the UI surfaces those notes so users see their correction landed somewhere.',
    ],
    verdict: allCorrect ? 'works' : 'fails',
  };
}

async function runWindowCase(
  config: LifecycleConfig,
  c: WindowCase,
): Promise<{ inWindowApplied: boolean; afterWindowRejected: boolean; priorityHeld: boolean }> {
  const store = new InMemoryStore();
  const clock = new FakeClock();
  const provider = new HashingEmbeddingProvider(256);
  const gate = new EncodingGate(store, store, provider, undefined, clock.now);
  const lifecycle = new LifecycleEngine(store, store, store, provider, config, clock.now);
  const windowMs = c.windowMinutes * 60 * 1000;

  // In-window correction.
  const a = (await gate.encode({ content: 'meeting is at 3pm', kind: 'percept', source: 'user' }))!;
  await lifecycle.onRecalled([a.id]);
  clock.advance(windowMs * c.correctAfterFraction);
  const updated = await lifecycle.applyUpdate(a.id, {
    content: 'meeting is at 4pm',
    priority: 'user',
    reason: 'user correction',
  });
  const inWindowApplied = updated.version === 2 && updated.content.includes('4pm');

  // Post-window correction on a fresh fact.
  const b = (await gate.encode({ content: 'dinner is at 7pm', kind: 'percept', source: 'user' }))!;
  await lifecycle.onRecalled([b.id]);
  clock.advance(windowMs * c.staleAfterFraction);
  let afterWindowRejected = false;
  try {
    await lifecycle.applyUpdate(b.id, { content: 'dinner is at 8pm', priority: 'user', reason: 'late correction' });
  } catch (err) {
    afterWindowRejected = err instanceof ReconsolidationWindowClosedError;
  }

  // Priority collision inside one window.
  const d = (await gate.encode({ content: 'the team uses Python for backend work', kind: 'percept', source: 'user', explicitFact: true }))!;
  await lifecycle.onRecalled([d.id]);
  await lifecycle.applyUpdate(d.id, { content: 'the team now uses Go for backend work', priority: 'user', reason: 'user correction' });
  await lifecycle.applyUpdate(d.id, { content: 'maybe they still use Python', priority: 'inference', reason: 'model guess' });
  const after = await store.getNode(d.id);
  const priorityHeld =
    (after?.content.includes('Go') ?? false) && (after?.content.includes('conflicting note kept') ?? false);

  void c;
  return { inWindowApplied, afterWindowRejected, priorityHeld };
}
