import { HashingEmbeddingProvider, InMemoryStore } from '@dream/core';
import { DreamKernel } from '@dream/kernel';
import { MockToolsPlugin, ScriptedReasoningPlugin } from '@dream/plugin-scripted';

/** Deterministic clock so reconsolidation windows and decay are controllable. */
export class FakeClock {
  private t: number;

  constructor(start = 1_700_000_000_000) {
    this.t = start;
  }

  readonly now = (): number => this.t;

  advance(ms: number): void {
    this.t += ms;
  }
}

export interface EvalInstance {
  kernel: DreamKernel;
  store: InMemoryStore;
  clock: FakeClock;
  scripted: ScriptedReasoningPlugin;
}

/** Fully initialized eval instance (plugins applied, deterministic clock). */
export async function createInstance(config?: Record<string, unknown>): Promise<EvalInstance> {
  const store = new InMemoryStore();
  const clock = new FakeClock();
  const scripted = new ScriptedReasoningPlugin();
  const kernel = new DreamKernel(
    {
      memory: store,
      journal: store,
      traces: store,
      provider: new HashingEmbeddingProvider(),
      clock: clock.now,
    },
    { preset: 'companion', dreamOnSessionClose: false, ...(config ?? {}) },
  );
  await kernel.use(scripted);
  await kernel.use(new MockToolsPlugin());
  return { kernel, store, clock, scripted };
}
