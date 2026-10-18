import { describe, expect, it } from 'vitest';
import { buildKernel } from './fixtures';

async function rigWithTool(config?: Record<string, unknown>) {
  const rig = await buildKernel({ config });
  rig.kernel.registerTool('eval-test', {
    name: 'apply_patch',
    description: 'apply a deterministic patch',
    parameters: { type: 'object', properties: {} },
    handler: (args) => {
      const { fail } = args as { fail?: boolean };
      if (fail) throw new Error('patch rejected');
      return 'applied';
    },
  });
  return rig;
}

describe('Artifact revision chain', () => {
  it('records successful edits and attaches them to recalled memories', async () => {
    const { kernel } = await rigWithTool();
    await kernel.encodeChunk({
      content: 'The search timeout fix lives in src/search.ts',
      kind: 'percept',
      source: 'user',
      explicitFact: true,
      meta: { artifactKeys: ['src/search.ts'] },
    });

    await kernel.executeTool({
      name: 'apply_patch',
      args: { path: 'src/search.ts', old: 'timeout: 30', new: 'timeout: 10' },
    });
    await kernel.executeTool({
      name: 'apply_patch',
      args: { path: 'src/search.ts', old: 'timeout: 10', new: 'timeout: 5' },
    });
    await kernel.executeTool({
      name: 'apply_patch',
      args: { path: 'src/search.ts', old: 'timeout: 5', new: 'timeout: 1', fail: true },
    });

    const recall = await kernel.recallContext('how did the search timeout change?');
    expect(recall.nodes.length).toBeGreaterThan(0);
    const revisions = recall.nodes[0]!.revisions ?? [];
    expect(revisions).toHaveLength(2);
    expect(revisions.map((revision) => revision.version)).toEqual([1, 2]);
    expect(revisions[0]!.diff).toContain('- timeout: 30');
    expect(revisions[1]!.diff).toContain('+ timeout: 5');
    expect(revisions.some((revision) => revision.newContent === 'timeout: 1')).toBe(false);
  });

  it('can withhold revisions from recall', async () => {
    const { kernel } = await rigWithTool({ attachRevisions: false });
    await kernel.encodeChunk({
      content: 'The search timeout fix lives in src/search.ts',
      kind: 'percept',
      source: 'user',
      explicitFact: true,
      meta: { artifactKeys: ['src/search.ts'] },
    });
    await kernel.executeTool({
      name: 'apply_patch',
      args: { path: 'src/search.ts', old: 'timeout: 30', new: 'timeout: 5' },
    });
    const recall = await kernel.recallContext('search timeout');
    expect(recall.nodes[0]!.revisions).toBeUndefined();
  });
});
