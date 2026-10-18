import { createInstance } from '../instance';
import { makeTable, type ExperimentResult } from './harness';

interface LinkResult {
  factHasExperience: boolean;
  factHasRevision: boolean;
  revisionHasFact: boolean;
  skillHasFact: boolean;
}

async function run(attachTriLinks: boolean): Promise<LinkResult> {
  const { kernel, store, clock } = await createInstance({ attachTriLinks });
  kernel.registerTool('trilink-eval', {
    name: 'apply_patch',
    description: 'apply a deterministic patch',
    parameters: { type: 'object', properties: {} },
    handler: () => 'applied',
  });

  const fact = (await kernel.encodeChunk({
    content: 'Deploy the billing service to staging',
    kind: 'percept',
    source: 'user',
    explicitFact: true,
    meta: { artifactKeys: ['deploy/billing.yaml'] },
  }))!;
  for (let i = 0; i < 3; i++) {
    await store.appendTrace({
      id: `trilink-${i}`,
      taskType: 'deploy-service',
      steps: [{ tool: 'apply_patch', args: {} }],
      outcome: 'success',
      ts: clock.now(),
      factIds: [fact.id],
      environment: 'staging',
    });
    clock.advance(1000);
  }
  await kernel.dreamNow();
  const [skill] = await store.listNodes({ kinds: ['procedural'] });

  await kernel.executeTool({
    name: 'apply_patch',
    args: { path: 'deploy/billing.yaml', old: 'replicas: 2', new: 'replicas: 3' },
  });
  const [revision] = await store.listRevisions('deploy/billing.yaml');
  await kernel.linkRevision(revision!.id, { factId: fact.id, experienceId: skill!.id });

  const factRecall = await kernel.recallContext('deploy billing service staging');
  const factNode = factRecall.nodes.find((node) => node.id === fact.id);
  const skillRecall = await kernel.recallContext('deploy-service skill');
  const skillNode = skillRecall.nodes.find((node) => node.id === skill!.id);

  return {
    factHasExperience: (factNode?.relatedExperiences?.length ?? 0) > 0,
    factHasRevision: (factNode?.revisions?.length ?? 0) > 0,
    revisionHasFact: (factNode?.revisions?.[0]?.sourceFactIds ?? []).includes(fact.id),
    skillHasFact: (skillNode?.sourceFacts?.length ?? 0) > 0,
  };
}

/**
 * E16 — TriLink: fact -> experience -> revision.
 *
 * Three memory layers are useful only if they can be traversed. A task fact
 * should surface the experience it produced and the exact diff it led to; an
 * experience should surface the facts that justify it. This experiment checks
 * the links end to end and that they can be withheld.
 */
export async function e16TriLink(): Promise<ExperimentResult> {
  const baseline = await run(false);
  const linked = await run(true);

  const rows: Array<Array<string | number>> = [
    [
      'fact -> experience',
      baseline.factHasExperience ? 'yes' : 'no',
      linked.factHasExperience ? 'yes' : 'no',
    ],
    [
      'fact -> revision',
      baseline.factHasRevision ? 'yes' : 'no',
      linked.factHasRevision ? 'yes' : 'no',
    ],
    [
      'revision -> fact',
      baseline.revisionHasFact ? 'yes' : 'no',
      linked.revisionHasFact ? 'yes' : 'no',
    ],
    [
      'experience -> fact',
      baseline.skillHasFact ? 'yes' : 'no',
      linked.skillHasFact ? 'yes' : 'no',
    ],
  ];

  const passed =
    !baseline.factHasExperience &&
    !baseline.skillHasFact &&
    linked.factHasExperience &&
    linked.factHasRevision &&
    linked.revisionHasFact &&
    linked.skillHasFact;

  const findings = [
    `Without TriLink expansion the fact still carried its diff (${baseline.factHasRevision ? 'yes' : 'no'}) but could not reach the experience that explains it (${baseline.factHasExperience ? 'yes' : 'no'}); the experience could not reach its source fact.`,
    `With TriLink: fact -> experience ${linked.factHasExperience ? 'yes' : 'no'}, fact -> revision ${linked.factHasRevision ? 'yes' : 'no'}, revision -> fact ${linked.revisionHasFact ? 'yes' : 'no'}, experience -> fact ${linked.skillHasFact ? 'yes' : 'no'}.`,
    `The links are mined at skill induction (trace.factIds -> skill.sourceFactIds, fact.derivedExperienceIds) and explicit for revisions (linkRevision), so provenance is data, not a prompt convention.`,
    `Expansion is capped at five neighbours per layer; a task with a long history cannot blow the context budget just because links exist.`,
  ];

  return {
    id: 'E16',
    title: 'TriLink: fact ↔ experience ↔ revision',
    question: 'Can recall traverse the task fact, the reusable experience, and the exact change it produced?',
    hypothesis:
      'Persisting bidirectional provenance between facts, experiences and revisions, then expanding it at recall with a cap, makes the three layers usable instead of three disconnected stores.',
    method: [
      'Encode a deploy fact referencing a config file; append three successful traces with factIds; consolidate to induce a skill.',
      'Apply a deterministic edit and link the revision to the fact/experience.',
      'Recall the fact and the skill with attachTriLinks off/on; check both directions and the revision link.',
    ],
    tables: [
      makeTable(
        'TriLink traversal',
        ['link', 'without expansion', 'with expansion'],
        rows,
      ),
    ],
    findings,
    recommendations: [
      'Mine fact links from trace.factIds at induction instead of asking an LLM to infer them later.',
      'Keep revision links explicit: only a deterministic edit knows which task fact it advanced.',
      'Cap expansion per layer; provenance is a graph, but the working set is still capacity-limited.',
    ],
    verdict: passed ? 'works' : 'partial',
  };
}
