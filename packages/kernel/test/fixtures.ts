import { HashingEmbeddingProvider, InMemoryStore } from '@dream/core';
import { DreamKernel } from '@dream/kernel';
import type { ApprovalService } from '@dream/policies';
import { MockToolsPlugin, ScriptedReasoningPlugin } from '@dream/plugin-scripted';
import { FakeClock } from '../../core/test/helpers';

export interface TestRig {
  kernel: DreamKernel;
  store: InMemoryStore;
  clock: FakeClock;
  scripted: ScriptedReasoningPlugin;
}

export async function buildKernel(options?: {
  config?: Record<string, unknown>;
  approval?: ApprovalService;
}): Promise<TestRig> {
  const store = new InMemoryStore();
  const clock = new FakeClock();
  const scripted = new ScriptedReasoningPlugin();
  const kernel = new DreamKernel(
    {
      memory: store,
      journal: store,
      traces: store,
      provider: new HashingEmbeddingProvider(),
      approval: options?.approval,
      clock: clock.now,
    },
    { preset: 'companion', dreamOnSessionClose: false, ...(options?.config ?? {}) },
  );
  await kernel.use(scripted);
  await kernel.use(new MockToolsPlugin());
  return { kernel, store, clock, scripted };
}
