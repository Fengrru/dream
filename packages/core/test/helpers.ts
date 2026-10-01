import { InMemoryStore } from '../src/store';
import { HashingEmbeddingProvider } from '../src/embeddings';
import { EncodingGate } from '../src/encoding';
import { LifecycleEngine, DEFAULT_LIFECYCLE_CONFIG, type LifecycleConfig } from '../src/lifecycle';
import { SelfModelManager } from '../src/self-model';

/** Deterministic clock so lifecycle windows and decay are testable. */
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

export interface CoreHarness {
  store: InMemoryStore;
  clock: FakeClock;
  provider: HashingEmbeddingProvider;
  gate: EncodingGate;
  lifecycle: LifecycleEngine;
  self: SelfModelManager;
}

export function buildCore(config?: Partial<LifecycleConfig>): CoreHarness {
  const store = new InMemoryStore();
  const clock = new FakeClock();
  const provider = new HashingEmbeddingProvider();
  const gate = new EncodingGate(store, store, provider, undefined, clock.now);
  const lifecycle = new LifecycleEngine(
    store,
    store,
    store,
    provider,
    { ...DEFAULT_LIFECYCLE_CONFIG, ...config },
    clock.now,
  );
  const self = new SelfModelManager(store, provider, store, clock.now);
  return { store, clock, provider, gate, lifecycle, self };
}
