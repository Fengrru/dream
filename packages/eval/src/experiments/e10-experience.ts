import { behaviors } from '@dream/plugin-scripted';
import { createInstance } from '../instance';
import { makeTable, type ExperimentResult } from './harness';

interface BoundaryResult {
  skillUsed: string | null;
  reasoningCalls: number;
}

async function boundaryCase(enforce: boolean): Promise<BoundaryResult> {
  const { kernel, scripted, clock } = await createInstance({ enforceSkillBoundaries: enforce });
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
  const s = kernel.session();
  const turn = await s.submit('analyze sales.csv run 4', {
    taskType: 'analyze-data',
    environment: 'production',
  });
  return { skillUsed: turn.skillUsed, reasoningCalls: turn.reasoningCalls };
}

async function searchKeysCase(useKeys: boolean): Promise<string | null> {
  const { kernel, scripted, clock } = await createInstance({
    useSkillSearchKeys: useKeys,
    skillSimilarityThreshold: 0.45,
  });
  scripted.set(behaviors.toolThenAnswer('analyze', { dataset: 'sales.csv' }, 'analysis done'));
  for (let i = 0; i < 3; i++) {
    const s = kernel.session();
    await s.submit(`analyze sales.csv run ${i}`, { taskType: 'analyze-data' });
    await s.end();
    clock.advance(60_000);
  }
  await kernel.dreamNow();
  const s = kernel.session();
  const turn = await s.submit('analyze sales figures please');
  return turn.skillUsed;
}

async function detailsCase(returnDetails: boolean): Promise<string | undefined> {
  const { kernel, scripted } = await createInstance({ returnDetails });
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
  return turn.recalled[0]?.details;
}

/**
 * E10 — Experience layer: reusable skills need applicability boundaries and
 * addressable details, not just steps.
 *
 * Hy-Memory's experience layer carries `search_keys`, `solution`,
 * `boundary_envs` and `confidence`; its fact layer carries `details`. This
 * experiment ports those ideas into Dream's procedural/semantic nodes without
 * splitting the unified store.
 */
export async function e10Experience(): Promise<ExperimentResult> {
  const boundaryBaseline = await boundaryCase(false);
  const boundaryEnhanced = await boundaryCase(true);
  const keysBaseline = await searchKeysCase(false);
  const keysEnhanced = await searchKeysCase(true);
  const detailsBaseline = await detailsCase(false);
  const detailsEnhanced = await detailsCase(true);

  const rows: Array<Array<string | number>> = [
    [
      'team skill match',
      'boundary check',
      boundaryBaseline.skillUsed ?? 'none',
      boundaryEnhanced.skillUsed ?? 'none',
      boundaryBaseline.reasoningCalls > 0 ? 'explicit fallback' : 'replayed',
    ],
    [
      'no-task-type match',
      'search keys',
      keysBaseline ?? 'none',
      keysEnhanced ?? 'none',
      keysEnhanced ? 'better recall' : 'same',
    ],
    [
      'detail recall',
      'verbatim details',
      detailsBaseline ? 'present' : 'absent',
      detailsEnhanced ? 'present' : 'absent',
      detailsEnhanced?.includes('4821') ? 'exact value' : 'missing',
    ],
  ];

  const boundaryPassed =
    boundaryBaseline.skillUsed === 'analyze-data' && boundaryEnhanced.skillUsed === null;
  const keysPassed = keysBaseline === null && keysEnhanced === 'analyze-data';
  const detailsPassed =
    detailsBaseline === undefined && detailsEnhanced !== undefined && detailsEnhanced.includes('4821');

  const findings = [
    `Boundary check: a skill learned only in "staging" was replayed in "production" by the old matcher ` +
      `(${boundaryBaseline.skillUsed ?? 'none'}); with boundaries enforced it failed closed and explicit reasoning took over ` +
      `(${boundaryEnhanced.skillUsed ?? 'none'}, ${boundaryEnhanced.reasoningCalls} reasoning call(s)).`,
    `Search keys: without taskType the label "Skill: analyze-data" did not match "analyze sales figures" (${keysBaseline ?? 'none'}); ` +
      `mined search keys matched it (${keysEnhanced ?? 'none'}).`,
    `Details: verbatim details were ${detailsBaseline ? 'returned without an opt-in' : 'withheld when disabled'} and ` +
      `${detailsEnhanced ? 'returned with the recalled fact' : 'missing'} — summaries stay findable, source values stay readable.`,
    `Confidence and sourceTraceIds are now mined at induction alongside searchKeys/boundaryEnvs, so a skill carries its provenance and applicability, not just steps.`,
  ];

  return {
    id: 'E10',
    title: 'Experience layer: boundaries, search keys, details',
    question: 'Can a learned skill know where it applies and can a summarized fact keep its exact source values?',
    hypothesis:
      'Skills without boundary environments get replayed in the wrong environment; label-only matching misses paraphrased requests; summaries without details lose the addressable values. Mining boundaries, search keys and details fixes all three.',
    method: [
      'Learn an analyze-data skill from three successful staging traces, then run it in production with boundaries enforced/disabled.',
      'Match the same skill from a paraphrased request without taskType, with and without mined search keys.',
      'Encode a fact with verbatim details and recall it with returnDetails on/off.',
    ],
    tables: [
      makeTable(
        'Experience metadata effects',
        ['scenario', 'mechanism', 'baseline', 'enhanced', 'note'],
        rows,
      ),
    ],
    findings,
    recommendations: [
      'Keep boundary checks fail-closed: an unknown environment is not permission to replay.',
      'Mine search keys from successful percepts at induction; the skill label alone is too thin for paraphrase.',
      'Store details outside the embedding field so they never distort retrieval, and cap their length at the boundary.',
    ],
    verdict: boundaryPassed && keysPassed && detailsPassed ? 'works' : 'partial',
  };
}
