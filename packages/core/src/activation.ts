import type { ChunkCandidate, MemoryNode, MemoryStore } from './types';
import type { EmbeddingProvider } from './embeddings';

export interface ActivationSet {
  workingSet: ChunkCandidate[];
  primed: ChunkCandidate[];
  scores: Map<string, number>;
}

export interface ActivationOptions {
  /** Number of focal chunks to fill (working memory capacity). */
  capacity?: number;
  /** Max hops of spreading activation over the association graph. */
  depth?: number;
  /** Per-hop attenuation of spreading activation. */
  spreadingDecay?: number;
  /** Minimum cosine for a semantic seed match. */
  semanticThreshold?: number;
  /** Recency half-life for episodic activation, ms. */
  recencyTauMs?: number;
  /** Minimum activation to enter the primed (pre-activated) set. */
  primedFloor?: number;
  /**
   * Exclude memories encoded in this session from recall — the contents of
   * current consciousness do not need to be "recalled"; they are already in
   * working memory. Prevents same-session echo pollution.
   */
  excludeSessionId?: string;
  now?: () => number;
}

const DEFAULTS: Required<Omit<ActivationOptions, 'now' | 'excludeSessionId'>> = {
  capacity: 4,
  depth: 2,
  spreadingDecay: 0.5,
  semanticThreshold: 0.08,
  recencyTauMs: 7 * 24 * 60 * 60 * 1000,
  primedFloor: 0.15,
};

interface Activated {
  node: MemoryNode;
  activation: number;
}

/**
 * Context activation: retrieval in Dream is active pre-activation, not passive
 * search. Given session context (topic seeds), the engine lights up a related
 * subset of the unified memory space:
 *
 * - semantic/self: nearest concepts, then spreading activation over the
 *   association graph (Collins & Loftus style, depth-limited),
 * - episodic: similarity blended with recency (recent experiences surface),
 * - procedural: skills matching the inferred task.
 *
 * The result splits into a working set (focal, enters working memory) and a
 * primed set (pre-activated but unfocused; lowered threshold for later cues,
 * the digital analogue of priming).
 */
export class ActivationEngine {
  constructor(private readonly provider: EmbeddingProvider) {}

  async activate(
    store: MemoryStore,
    seeds: string[],
    options: ActivationOptions = {},
  ): Promise<ActivationSet> {
    const opts = { ...DEFAULTS, ...options, now: options.now ?? Date.now };
    const now = opts.now();
    const query = (await this.provider.embed([seeds.join('\n')]))[0]!;
    // Same-session episodic junk (questions, echoes, tool results) is already
    // in or passing through working memory — recalling it back is pollution.
    // Semantic facts and skills stated/formed this session stay recallable.
    const fromSameSession = (n: MemoryNode): boolean =>
      opts.excludeSessionId !== undefined &&
      n.provenance.sessionId === opts.excludeSessionId &&
      n.kind === 'episodic';

    const byId = new Map<string, Activated>();
    // Retrievability gate: memory strength (decayed by adaptive forgetting)
    // scales activation. A faded memory is harder to recall but not gone —
    // the 0.25 floor leaves it reachable by a strong cue (experiment E3's
    // "strong cues can revive" promise, applied to recall itself).
    const gate = (node: MemoryNode, act: number): number => act * (0.25 + 0.75 * node.strength);
    const bump = (node: MemoryNode, act: number, combine = 'max' as 'max' | 'add') => {
      const prev = byId.get(node.id);
      if (combine === 'add' && prev) {
        prev.activation = Math.min(1.5, prev.activation + act);
      } else if (!prev || act > prev.activation) {
        byId.set(node.id, { node, activation: act });
      }
    };

    // 1. Semantic + self seeds, gated by salience: activation blends
    // similarity with importance (experiment E2 — pattern abstractions must
    // outrank individually-recency-boosted episodes for pattern queries).
    const semanticHits = await store.searchByEmbedding(
      query,
      8,
      { kinds: ['semantic', 'self'], excludeQuarantined: true, minStrength: 0.05 },
    );
    for (const hit of semanticHits) {
      // Two-gate entry: a lenient raw-similarity floor (lexical relevance)
      // plus the gated salience needing to clear the priming floor. The old
      // single 0.35 cosine gate rejected centroid-embedded abstractions
      // (~0.2 similarity) even when they were the best possible answer.
      const act = gate(hit.node, 0.75 * hit.similarity + 0.25 * hit.node.importance);
      if (
        hit.similarity >= opts.semanticThreshold &&
        act >= opts.primedFloor &&
        !fromSameSession(hit.node)
      ) {
        bump(hit.node, act);
      }
    }

    // 2. Spreading activation from the strongest seeds.
    const frontier = [...byId.values()]
      .sort((a, b) => b.activation - a.activation)
      .slice(0, 5);
    let current = new Map(frontier.map((f) => [f.node.id, f] as const));
    for (let depth = 1; depth <= opts.depth; depth++) {
      const next = new Map<string, Activated>();
      for (const { node, activation } of current.values()) {
        const edges = await store.getEdges(node.id);
        for (const edge of edges) {
          if (byId.has(edge.to) && !next.has(edge.to)) continue;
          const neighbor = await store.getNode(edge.to);
          if (!neighbor || neighbor.quarantined || neighbor.strength < 0.05) continue;
          const act = activation * edge.weight * Math.pow(opts.spreadingDecay, depth);
          if (act >= opts.primedFloor) next.set(neighbor.id, { node: neighbor, activation: act });
        }
      }
      for (const a of next.values()) bump(a.node, a.activation, 'add');
      current = next;
      if (current.size === 0) break;
    }

    // 3. Episodic: similarity + recency.
    const episodicHits = await store.searchByEmbedding(
      query,
      8,
      { kinds: ['episodic'], excludeQuarantined: true, minStrength: 0.05 },
    );
    for (const hit of episodicHits) {
      if (fromSameSession(hit.node)) continue;
      const age = Math.max(0, now - hit.node.lastAccessedAt);
      const recency = Math.exp(-age / opts.recencyTauMs);
      bump(hit.node, gate(hit.node, 0.65 * hit.similarity + 0.35 * recency));
    }

    // 4. Procedural: skills matching the current context.
    const skillHits = await store.searchByEmbedding(
      query,
      4,
      { kinds: ['procedural'], excludeQuarantined: true, minStrength: 0.05 },
    );
    for (const hit of skillHits) {
      if (hit.similarity >= 0.3) bump(hit.node, gate(hit.node, hit.similarity));
    }

    const ranked = [...byId.values()].sort((a, b) => b.activation - a.activation);

    const asCandidate = (a: Activated, primed: boolean): ChunkCandidate => ({
      content: a.node.content,
      kind: 'recalled',
      source: 'agent',
      meta: {
        nodeId: a.node.id,
        nodeKind: a.node.kind,
        scope: a.node.scope,
        activation: a.activation,
        primed,
      },
    });

    const workingSet = ranked.slice(0, opts.capacity).map((a) => asCandidate(a, false));
    const primed = ranked
      .slice(opts.capacity, opts.capacity + 12)
      .filter((a) => a.activation >= opts.primedFloor)
      .map((a) => asCandidate(a, true));

    const scores = new Map(ranked.map((a) => [a.node.id, a.activation] as const));
    return { workingSet, primed, scores };
  }
}
