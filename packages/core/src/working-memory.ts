import type { ChunkCandidate, ChunkKind, ChunkSource, WMChunk, WMSnapshot } from './types';
import { newId } from './ids';

const ACTIVATION_TAU_MS = 120_000;

/**
 * Working memory is the cognitive bus: the only exchange medium between
 * plugins. Capacity is hard-limited (4±1 chunks) to force attention focus;
 * chunks are pointers, so capacity limits the number of focal items, not the
 * amount of accessible information.
 *
 * Eviction is deterministic: the least-active chunk is squeezed out, and the
 * caller is expected to route it to the encoding gate (attention lapse is how
 * material reaches long-term memory).
 */
export class WorkingMemory {
  private chunks: WMChunk[] = [];

  constructor(
    public readonly capacity = 4,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Bring a candidate into the focal set. When over capacity, the least-active
   * chunk is evicted and returned so the executive can encode it.
   */
  attend(candidate: ChunkCandidate, activation = 1): WMChunk | null {
    const t = this.now();
    const chunk: WMChunk = {
      id: newId('wm'),
      candidate,
      activation,
      lastRefreshedAt: t,
      attendedAt: t,
    };
    if (this.chunks.length < this.capacity) {
      this.chunks.push(chunk);
      return null;
    }
    let evictIdx = 0;
    for (let i = 1; i < this.chunks.length; i++) {
      const cur = this.chunks[i]!;
      const best = this.chunks[evictIdx]!;
      if (cur.activation < best.activation || (cur.activation === best.activation && cur.lastRefreshedAt < best.lastRefreshedAt)) {
        evictIdx = i;
      }
    }
    const evicted = this.chunks[evictIdx]!;
    this.chunks[evictIdx] = chunk;
    return structuredClone(evicted);
  }

  refresh(id: string): boolean {
    const chunk = this.chunks.find((c) => c.id === id);
    if (!chunk) return false;
    chunk.lastRefreshedAt = this.now();
    chunk.activation = Math.min(1, chunk.activation + 0.2);
    return true;
  }

  /** Passive decay of activation over elapsed time (attentional lapse). */
  tick(): void {
    const t = this.now();
    for (const chunk of this.chunks) {
      const dt = t - chunk.lastRefreshedAt;
      if (dt > 0) chunk.activation *= Math.exp(-dt / ACTIVATION_TAU_MS);
    }
  }

  readAll(): WMChunk[] {
    return structuredClone(this.chunks);
  }

  findByKind(kind: ChunkKind): WMChunk[] {
    return this.readAll().filter((c) => c.candidate.kind === kind);
  }

  /** Drain every remaining chunk (used at session end before encoding). */
  drain(): WMChunk[] {
    const out = this.chunks;
    this.chunks = [];
    return out;
  }

  snapshot(): WMSnapshot {
    return {
      at: this.now(),
      items: this.chunks.map((c) => ({
        kind: c.candidate.kind,
        content: c.candidate.content,
        activation: c.activation,
        source: c.candidate.source,
      })),
    };
  }
}

export type { ChunkSource };
