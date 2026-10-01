import { describe, expect, it } from 'vitest';
import { PolicyViolationError } from '@dream/core';
import { buildKernel } from './fixtures';

describe('Plugin capability enforcement (deny-by-default)', () => {
  it('rejects undeclared memory operations', async () => {
    const { kernel } = await buildKernel();

    // The public path: a plugin's facade must throw on undeclared ops.
    let captured: any;
    await kernel.use({
      name: 'capturer',
      apply(ctx) {
        captured = ctx.memory;
      },
    });

    await expect(
      captured.encode({ content: 'x', kind: 'percept', source: 'user' }),
    ).rejects.toBeInstanceOf(PolicyViolationError);
    await expect(captured.forget('mem_abc', 'reason')).rejects.toBeInstanceOf(PolicyViolationError);
  });

  it('allows declared capabilities', async () => {
    const { kernel } = await buildKernel();
    let captured: any;
    await kernel.use({
      name: 'writer',
      memory: { encode: true, recall: true },
      apply(ctx) {
        captured = ctx.memory;
      },
    });
    const node = await captured.encode({ content: 'a fact worth keeping', kind: 'percept', source: 'user' });
    expect(node).not.toBeNull();
    const recall = await captured.recall('a fact worth keeping');
    expect(recall.nodes.length).toBeGreaterThan(0);
  });
});
