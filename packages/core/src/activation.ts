import type { ChunkCandidate, MemoryKind, MemoryNode, MemoryStore } from './types';
import type { Tracer } from './tracing';
import type { EmbeddingProvider } from './embeddings';
import { cosineSimilarity } from './embeddings';
import { bm25Rank, lexicalTokens } from './lexical';

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
   * Weight of the BM25 lexical channel added to vector activation. 0 disables
   * the channel (baseline behavior). The lexical channel is what keeps rare
   * identifiers and short precise facts above long keyword-stuffed noise.
   */
  lexicalWeight?: number;
  /** Minimum normalized BM25 score for a lexical candidate. */
  lexicalMinScore?: number;
  /** Minimum fraction of distinct query tokens a lexical candidate must match. */
  lexicalMinCoverage?: number;
  /** Include CJK tokens in the lexical channel (default true; false = legacy ASCII ablation). */
  lexicalCjk?: boolean;
  /** Restrict recall to one owner partition. */
  userId?: string;
  /** Boost memories tagged with this scene (unified space, no store split). */
  scene?: string;
  /** Only records valid at this instant (event-time recall). */
  asOf?: number;
  /** Only records written at/after this instant. */
  createdAfter?: number;
  /** Optional stage sink; events carry counts/durations/hashes, never content. */
  tracer?: Tracer;
  traceId?: string;
  /**
   * Cosine above which a same-kind near-duplicate is skipped while filling the
   * working set, so four paraphrase copies cannot crowd out four distinct
   * memories. 1 disables the diversity pass.
   */
  diversityThreshold?: number;
  /**
   * Kinds subject to the near-duplicate filter. Episodic memory is excluded by
   * default: "took medicine" repeated on different days is a legitimate
   * sequence of distinct events, not redundancy.
   */
  diversityKinds?: MemoryKind[];
  /**
   * Exclude memories encoded in this session from recall — the contents of
   * current consciousness do not need to be "recalled"; they are already in
   * working memory. Prevents same-session echo pollution.
   */
  excludeSessionId?: string;
  now?: () => number;
}

const DEFAULTS: Required<
  Omit<
    ActivationOptions,
    'now' | 'excludeSessionId' | 'userId' | 'scene' | 'asOf' | 'createdAfter' | 'tracer' | 'traceId'
  >
> & {
  userId?: string;
  scene?: string;
  asOf?: number;
  createdAfter?: number;
  tracer?: Tracer;
  traceId?: string;
} = {
  capacity: 4,
  depth: 2,
  spreadingDecay: 0.5,
  semanticThreshold: 0.08,
  recencyTauMs: 7 * 24 * 60 * 60 * 1000,
  primedFloor: 0.15,
  lexicalWeight: 0.4,
  lexicalMinScore: 0,
  lexicalMinCoverage: 0.3,
  lexicalCjk: true,
  userId: undefined,
  scene: undefined,
  diversityThreshold: 0.95,
  diversityKinds: ['semantic', 'procedural'],
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
  /** Per-node token cache: content changes are rare, tokenization is not. */
  private readonly tokenCache = new Map<string, { content: string; tokens: string[] }>();

  constructor(private readonly provider: EmbeddingProvider) {}

  async activate(
    store: MemoryStore,
    seeds: string[],
    options: ActivationOptions = {},
  ): Promise<ActivationSet> {
    const opts = { ...DEFAULTS, ...options, now: options.now ?? Date.now };
    const now = opts.now();
    const trace = (stage: Parameters<Tracer['event']>[0]['stage'], startedAt: number, meta?: Record<string, string | number | boolean | undefined>): void => {
      if (!opts.tracer?.enabled || !opts.traceId) return;
      opts.tracer.event({
        traceId: opts.traceId,
        stage,
        ts: now,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
        meta,
      });
    };
    const embedStarted = performance.now();
    const query = (await this.provider.embed([seeds.join('\n')]))[0]!;
    trace('embed', embedStarted, { seedCount: seeds.length });
    // Same-session episodic junk (questions, echoes, tool results) is already
    // in or passing through working memory — recalling it back is pollution.
    // Semantic facts and skills stated/formed this session stay recallable.
    const temporalOk = (n: MemoryNode): boolean => {
      if (opts.createdAfter !== undefined && n.createdAt < opts.createdAfter) return false;
      if (opts.asOf === undefined) return true;
      const from = n.validFrom ?? Number.NEGATIVE_INFINITY;
      const until = n.validUntil ?? Number.POSITIVE_INFINITY;
      return opts.asOf >= from && opts.asOf <= until;
    };
    const confidenceFactor = (n: MemoryNode): number => 0.8 + 0.2 * (n.confidence ?? 1);
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
    const semanticStarted = performance.now();
    const semanticHits = await store.searchByEmbedding(
      query,
      8,
      {
        kinds: ['semantic', 'self'],
        excludeQuarantined: true,
        minStrength: 0.05,
        userId: opts.userId,
        asOf: opts.asOf,
        createdAfter: opts.createdAfter,
      },
    );
    for (const hit of semanticHits) {
      // Two-gate entry: a lenient raw-similarity floor (lexical relevance)
      // plus the gated salience needing to clear the priming floor. The old
      // single 0.35 cosine gate rejected centroid-embedded abstractions
      // (~0.2 similarity) even when they were the best possible answer.
      const act = gate(
        hit.node,
        (0.75 * hit.similarity + 0.25 * hit.node.importance) * confidenceFactor(hit.node),
      );
      if (
        hit.similarity >= opts.semanticThreshold &&
        act >= opts.primedFloor &&
        !fromSameSession(hit.node)
      ) {
        bump(hit.node, act);
      }
    }
    trace('semantic', semanticStarted, {
      hits: semanticHits.length,
      activated: byId.size,
    });

    // 2. Spreading activation from the strongest seeds.
    const spreadStarted = performance.now();
    let spreadAdded = 0;
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
          if (opts.userId !== undefined && (neighbor.userId ?? 'default') !== opts.userId) continue;
          // Version edges connect a current record to its retired ancestors;
          // spreading activation must not resurrect them into context.
          if (neighbor.isLatest === false) continue;
          if (!temporalOk(neighbor)) continue;
          const act = activation * edge.weight * Math.pow(opts.spreadingDecay, depth);
          if (act >= opts.primedFloor) next.set(neighbor.id, { node: neighbor, activation: act });
        }
      }
      for (const a of next.values()) {
        bump(a.node, a.activation, 'add');
        spreadAdded++;
      }
      current = next;
      if (current.size === 0) break;
    }
    trace('spread', spreadStarted, { added: spreadAdded, depth: opts.depth });

    // 3. Episodic: similarity + recency.
    const episodicStarted = performance.now();
    const episodicHits = await store.searchByEmbedding(
      query,
      8,
      {
        kinds: ['episodic'],
        excludeQuarantined: true,
        minStrength: 0.05,
        userId: opts.userId,
        asOf: opts.asOf,
        createdAfter: opts.createdAfter,
      },
    );
    for (const hit of episodicHits) {
      if (fromSameSession(hit.node)) continue;
      const age = Math.max(0, now - hit.node.lastAccessedAt);
      const recency = Math.exp(-age / opts.recencyTauMs);
      bump(
        hit.node,
        gate(hit.node, (0.65 * hit.similarity + 0.35 * recency) * confidenceFactor(hit.node)),
      );
    }
    trace('episodic', episodicStarted, { hits: episodicHits.length });

    // 4. Procedural: skills matching the current context.
    const proceduralStarted = performance.now();
    const skillHits = await store.searchByEmbedding(
      query,
      4,
      {
        kinds: ['procedural'],
        excludeQuarantined: true,
        minStrength: 0.05,
        userId: opts.userId,
        asOf: opts.asOf,
        createdAfter: opts.createdAfter,
      },
    );
    for (const hit of skillHits) {
      if (hit.similarity >= 0.3) {
        bump(hit.node, gate(hit.node, hit.similarity * confidenceFactor(hit.node)));
      }
    }
    trace('procedural', proceduralStarted, { hits: skillHits.length });

    // 5. Lexical (BM25) channel: exact-term recall and IDF weighting. This is
    //    the Hy-Memory-style hybrid reader — vector channels decide relevance,
    //    the lexical channel rescues precise facts the hashed embedding
    //    underweights (rare identifiers, short facts beside keyword-stuffed
    //    logs) and adds activation on a common normalized scale.
    if (opts.lexicalWeight > 0) {
      const lexicalStarted = performance.now();
      const filter = {
        excludeQuarantined: true,
        minStrength: 0.05,
        userId: opts.userId,
        asOf: opts.asOf,
        createdAfter: opts.createdAfter,
      };
      const nodes = store.listNodesForScoring
        ? await store.listNodesForScoring(filter)
        : await store.listNodes(filter);
      if (this.tokenCache.size > 20_000) this.tokenCache.clear();
      const hits = bm25Rank(
        nodes.map((node) => {
          const cacheKey = `${node.id}|${opts.lexicalCjk}`;
          let entry = this.tokenCache.get(cacheKey);
          if (!entry || entry.content !== node.content) {
            entry = {
              content: node.content,
              tokens: lexicalTokens(node.content, { cjk: opts.lexicalCjk }),
            };
            this.tokenCache.set(cacheKey, entry);
          }
          return { id: node.id, tokens: entry.tokens };
        }),
        seeds.join('\n'),
        { cjk: opts.lexicalCjk },
      );
      const byNodeId = new Map(nodes.map((node) => [node.id, node] as const));
      let maxActivation = 0;
      for (const activated of byId.values()) {
        if (activated.activation > maxActivation) maxActivation = activated.activation;
      }
      // Interpolate toward the lexical score rather than only adding to it.
      // An additive boost cannot fix a collision: the wrong neighbour starts
      // far enough ahead that a small bonus leaves it on top. Interpolation
      // both lifts the exact match and demotes the high-vector / low-lexical
      // neighbour, on the same bounded scale.
      for (const hit of hits) {
        if (hit.normalized < opts.lexicalMinScore) continue;
        if (hit.matchedRatio < opts.lexicalMinCoverage) continue;
        const node = byNodeId.get(hit.id);
        if (!node || fromSameSession(node)) continue;
        const target =
          maxActivation *
          hit.normalized *
          (0.25 + 0.75 * node.strength) *
          confidenceFactor(node);
        const previous = byId.get(node.id);
        const fused =
          (1 - opts.lexicalWeight) * (previous?.activation ?? 0) + opts.lexicalWeight * target;
        if (previous) previous.activation = fused;
        else if (fused > 0) byId.set(node.id, { node, activation: fused });
      }
      trace('lexical', lexicalStarted, { docs: nodes.length, hits: hits.length });
    }

    // Scene boost + prospective-intention boost. The store stays unified: a
    // scene is a retrieval prior, not a separate memory palace.
    const nowTs = now;
    for (const activated of byId.values()) {
      let boost = 0;
      if (opts.scene && activated.node.meta?.['scene'] === opts.scene) boost += 0.1;
      const expiresAt = activated.node.meta?.['expiresAt'];
      if (
        activated.node.meta?.['intention'] === true &&
        typeof expiresAt === 'number' &&
        expiresAt > nowTs
      ) {
        boost += 0.05;
      }
      if (boost > 0) activated.activation = Math.min(1.5, activated.activation + boost);
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
        details: typeof a.node.meta?.['details'] === 'string' ? a.node.meta['details'] : undefined,
        userId: a.node.userId ?? 'default',
        confidence: a.node.confidence ?? 1,
        evidenceCount: a.node.evidenceCount ?? 1,
        eventTime: a.node.eventTime,
        validFrom: a.node.validFrom,
        validUntil: a.node.validUntil,
        intention: a.node.meta?.['intention'] === true,
        expiresAt: typeof a.node.meta?.['expiresAt'] === 'number' ? a.node.meta['expiresAt'] : undefined,
        scene: typeof a.node.meta?.['scene'] === 'string' ? a.node.meta['scene'] : undefined,
      },
    });

    // Diversity pass: a paraphrase cluster should not consume the whole
    // capacity-limited working set. Near-duplicates (same kind, cosine above
    // the threshold) are deferred to the primed set, where a later cue can
    // still reach them.
    const dedupStarted = performance.now();
    const selected: Activated[] = [];
    const deferred: Activated[] = [];
    for (const candidate of ranked) {
      const duplicate =
        opts.diversityThreshold < 1 &&
        opts.diversityKinds.includes(candidate.node.kind) &&
        selected.some(
          (chosen) =>
            chosen.node.kind === candidate.node.kind &&
            cosineSimilarity(chosen.node.embedding, candidate.node.embedding) > opts.diversityThreshold,
        );
      if (selected.length < opts.capacity && !duplicate) selected.push(candidate);
      else deferred.push(candidate);
    }

    trace('dedup', dedupStarted, {
      selected: selected.length,
      deferred: deferred.length,
      capacity: opts.capacity,
    });
    const workingSet = selected.map((a) => asCandidate(a, false));
    const primed = deferred
      .filter((a) => a.activation >= opts.primedFloor)
      .slice(0, 12)
      .map((a) => asCandidate(a, true));

    const scores = new Map(ranked.map((a) => [a.node.id, a.activation] as const));
    return { workingSet, primed, scores };
  }
}
