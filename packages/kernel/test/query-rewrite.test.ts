import { describe, expect, it } from 'vitest';
import { QueryRewritePlugin, expandQuery } from '@dream/plugin-query-rewrite';
import { buildKernel } from './fixtures';

describe('Query rewrite plugin', () => {
  it('appends domain terms without replacing the original query', () => {
    const rewritten = expandQuery('When is the deploy window?');
    expect(rewritten).toContain('deploy window');
    expect(rewritten).toContain('release');
    expect(rewritten).toContain('schedule');
    expect(expandQuery('部署窗口是什么时候？')).toContain('发布时间');
  });

  it('improves recall for a synonymous query', async () => {
    const run = async (withPlugin: boolean) => {
      const { kernel, store } = await buildKernel({ config: { retrievalDiversityThreshold: 1 } });
      if (withPlugin) await kernel.use(new QueryRewritePlugin());
      const facts = [
        'The billing service release schedule is Friday at 2am UTC.',
        'The staging deploy window is Monday at 9am UTC.',
        'The payroll service release schedule is Tuesday at 4am UTC.',
      ];
      for (let i = 0; i < facts.length; i++) {
        const content = facts[i]!;
        await store.putNode({
          id: `mem_${i}`,
          kind: 'semantic',
          scope: 'user',
          userId: 'default',
          content,
          embedding: (await kernel.provider.embed([content]))[0]!,
          edges: [],
          provenance: { source: 'user', trust: 1 },
          importance: 0.8,
          strength: 1,
          createdAt: Date.now(),
          lastAccessedAt: Date.now(),
          version: 1,
        });
      }
      const recall = await kernel.recallContext('When is the billing service deploy window?');
      return recall.nodes[0]?.content ?? '';
    };

    const baseline = await run(false);
    const enhanced = await run(true);
    expect(enhanced).toContain('release schedule');
    expect(baseline).toContain('staging');
  });
});
