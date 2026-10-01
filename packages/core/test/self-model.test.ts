import { describe, expect, it } from 'vitest';
import { buildCore } from './helpers';

describe('SelfModelManager', () => {
  it('creates expertise nodes and boosts confidence with experience', async () => {
    const { self, lifecycle, store } = buildCore();
    await self.boostExpertise('data-analysis', 0.15);
    await self.boostExpertise('data-analysis', 0.15);
    const summary = await self.summarize();
    expect(summary).toContain('data-analysis');
    expect(summary).toContain('0.80'); // 0.5 + 0.15 + 0.15
    void lifecycle; void store;
  });

  it('records known unknowns from failures', async () => {
    const { self } = buildCore();
    await self.addKnownUnknown('rust-compilation');
    const summary = await self.summarize();
    expect(summary).toContain('Known unknown: rust-compilation');
  });

  it('stores opinions with confidence', async () => {
    const { self } = buildCore();
    await self.setOpinion('typescript-vs-python', 'TypeScript for agent kernels', 0.8);
    const summary = await self.summarize();
    expect(summary).toContain('On typescript-vs-python');
    expect(summary).toContain('0.80');
  });

  it('stores self-knowledge in the unified space as agent-scope memory', async () => {
    const { self, store } = buildCore();
    await self.boostExpertise('writing', 0.1);
    const nodes = await store.listNodes({ kinds: ['self'] });
    expect(nodes.length).toBe(1);
    expect(nodes[0]!.scope).toBe('agent');
    expect(nodes[0]!.kind).toBe('self');
  });
});
