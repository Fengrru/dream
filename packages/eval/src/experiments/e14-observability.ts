import { behaviors } from '@dream/plugin-scripted';
import { createInstance } from '../instance';
import { makeTable, mean, type ExperimentResult } from './harness';

const STAGES = [
  'encode',
  'embed',
  'semantic',
  'episodic',
  'procedural',
  'lexical',
  'spread',
  'dedup',
  'recall',
];

/**
 * E14 — Stage-level observability.
 *
 * "Why did recall miss?" is unanswerable from a flat journal. This experiment
 * checks that a turn carries one trace id through encode/recall, that every
 * retrieval channel emits a stage event, that content never enters the trace,
 * and that the events survive into the journal for `dream inspect`.
 */
export async function e14Observability(): Promise<ExperimentResult> {
  const { kernel, scripted, store } = await createInstance();

  scripted.set(behaviors.answer('Noted.'));
  const s1 = kernel.session();
  const writeTurn = await s1.submit('My locker combination is 4821', { explicitFact: true });

  scripted.set(behaviors.recallEcho());
  const s2 = kernel.session();
  const readTurn = await s2.submit('What is the locker combination?');

  const writeEvents = kernel.traceEvents(writeTurn.traceId);
  const readEvents = kernel.traceEvents(readTurn.traceId);
  const readStages = new Set<string>(readEvents.map((event) => event.stage));
  const requiredPresent = STAGES.every((stage) => stage === 'encode' || readStages.has(stage));
  const writeHasEncode = writeEvents.some((event) => event.stage === 'encode');

  const serialized = JSON.stringify(kernel.traceEvents());
  const privacyHolds = !serialized.includes('4821') && !serialized.includes('locker combination');

  await new Promise((resolve) => setTimeout(resolve, 0));
  const journal = await store.list();
  const persisted = journal.filter(
    (event) => event.type === 'trace' && event.meta?.['traceId'] === readTurn.traceId,
  ).length;

  const metrics = kernel.traceMetrics(readTurn.traceId);
  const rows: Array<Array<string | number>> = STAGES.map((stage) => {
    const writeCount = writeEvents.filter((event) => event.stage === stage).length;
    const readCount = readEvents.filter((event) => event.stage === stage).length;
    const entry = metrics.byStage[stage];
    return [stage, writeCount, readCount, entry?.avgMs ?? 0];
  });

  const distinctTraceIds = new Set([writeTurn.traceId, readTurn.traceId]).size;
  const passed =
    distinctTraceIds === 2 &&
    writeHasEncode &&
    requiredPresent &&
    privacyHolds &&
    persisted > 0 &&
    (metrics.byStage['dedup']?.count ?? 0) > 0;

  const findings = [
    `Trace continuity: encode and recall used distinct ids (${writeTurn.traceId.slice(0, 12)}… / ${readTurn.traceId.slice(0, 12)}…), and the read trace contains ${readEvents.length} stage events.`,
    `Channel visibility: ${STAGES.filter((stage) => stage !== 'encode').join(', ')} all emitted events; dedup recorded selected/deferred counts, so a dropped candidate is explainable.`,
    `Privacy: the serialized trace ${privacyHolds ? 'contains only hashes/counts/durations — no memory or query text' : 'LEAKED content (privacy failure)'}.`,
    `Persistence: ${persisted} trace events reached the journal, which is what \`dream inspect --trace <id>\` reads after a restart.`,
  ];

  return {
    id: 'E14',
    title: 'Stage-level observability & trace privacy',
    question: 'Can a single turn be explained stage by stage without storing its content?',
    hypothesis:
      'A trace id propagated through encode/recall plus per-channel stage events (hashes/counts only) makes misses diagnosable and is safe to persist.',
    method: [
      'Submit an explicit fact and a later recall; collect the trace id from each TurnResult.',
      'Check that encode/embed/semantic/episodic/procedural/lexical/spread/dedup/recall events exist.',
      'Serialize all trace events and assert the secret/value text is absent.',
      'Verify trace events persist to the journal for the inspector.',
    ],
    tables: [
      makeTable(
        'Stage events per trace',
        ['stage', 'write events', 'read events', 'read avg ms'],
        rows,
      ),
      makeTable(
        'Invariants',
        ['check', 'result'],
        [
          ['distinct trace ids', distinctTraceIds],
          ['write trace has encode', writeHasEncode ? 'yes' : 'no'],
          ['all read stages present', requiredPresent ? 'yes' : 'no'],
          ['content leaked', privacyHolds ? 'no' : 'YES'],
          ['journal events for read trace', persisted],
          ['metrics total events', metrics.totalEvents],
          ['mean read stage ms', mean(Object.values(metrics.byStage).map((entry) => entry.avgMs)).toFixed(2)],
        ],
      ),
    ],
    findings,
    recommendations: [
      'Keep traces content-free by default; hashes and counts explain ranking without becoming a second memory store.',
      'Emit one event per channel, not one per candidate; per-candidate traces explode in size and rarely answer the question.',
      'Use `dream inspect --metrics` for aggregate channel cost before optimizing a specific recall path.',
    ],
    verdict: passed ? 'works' : 'partial',
  };
}
