import { describe, expect, it } from 'vitest';
import { buildKernel } from './fixtures';

async function setup(attachTriLinks: boolean) {
  const rig = await buildKernel({ config: { attachTriLinks } });
  const { kernel, store, clock } = rig;
  kernel.registerTool('tri-link', {
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
      id: `trace-${i}`,
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
  return { ...rig, fact, skill: skill! };
}

describe('TriLink memory layers', () => {
  it('expands fact -> experience -> revision and experience -> fact', async () => {
    const { kernel, fact, skill } = await setup(true);

    const factRecall = await kernel.recallContext('deploy the billing service to staging');
    const factNode = factRecall.nodes.find((node) => node.id === fact.id);
    expect(factNode).toBeDefined();
    expect(factNode!.relatedExperiences?.map((experience) => experience.id)).toContain(skill.id);
    expect(factNode!.revisions?.map((revision) => revision.newContent)).toContain('replicas: 3');
    expect(factNode!.revisions?.[0]?.sourceFactIds).toContain(fact.id);

    const skillRecall = await kernel.recallContext('deploy-service skill');
    const skillNode = skillRecall.nodes.find((node) => node.id === skill.id);
    expect(skillNode).toBeDefined();
    expect(skillNode!.sourceFacts?.map((source) => source.id)).toContain(fact.id);
  });

  it('can withhold link expansion', async () => {
    const { kernel, fact } = await setup(false);
    const recall = await kernel.recallContext('deploy the billing service to staging');
    const node = recall.nodes.find((item) => item.id === fact.id);
    expect(node).toBeDefined();
    expect(node!.relatedExperiences).toBeUndefined();
  });
});
