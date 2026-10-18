import type {
  Association,
  ChunkCandidate,
  MemoryKind,
  MemoryNode,
  MemoryStore,
} from './types';
import type { Tracer } from './tracing';
import { matchingTags } from './entities';
import { reciprocalRankFusion, type FusionChannelEntry } from './fusion';
import type { Activated } from './retrieval-types';
import { selectActivated } from './selection';
import type { EmbeddingProvider } from './embeddings';
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
  /** Weight of the entity/tag channel (0 disables). */
  tagWeight?: number;
  /** Same-episode support weight (0 disables). */
  episodeWeight?: number;
  /** Maximum working-set slots per memory kind (unset = unlimited). */
  maxPerKind?: Partial<Record<MemoryKind, number>>;
  /** Kinds that get one slot before rank-based filling, if available. */
  reservedKinds?: MemoryKind[];
  /** Score fusion across channels: interpolated activation (default) or rank fusion. */
  fusion?: 'interpolate' | 'rrf';
  /** RRF smoothing constant. */
  rrfK?: number;
  /** Multiplicative priors by edge type during spreading (unset = 1). */
  relationPriors?: Partial<Record<Association['type'], number>>;
  /** Normalize spreading by sqrt(out-degree) to prevent hub dominance. */
  degreeNormalize?: boolean;
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
    | 'now'
    | 'excludeSessionId'
    | 'userId'
    | 'scene'
    | 'asOf'
    | 'createdAfter'
    | 'tracer'
    | 'traceId'
    | 'maxPerKind'
    | 'reservedKinds'
    | 'relationPriors'
  >
> & {
  userId?: string;
  scene?: string;
  asOf?: number;
  createdAfter?: number;
  tracer?: Tracer;
  traceId?: string;
  maxPerKind?: Partial<Record<MemoryKind, number>>;
  reservedKinds?: MemoryKind[];
  relationPriors?: Partial<Record<Association['type'], number>>;
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
  tagWeight: 0.15,
  episodeWeight: 0,
  fusion: 'interpolate',
  rrfK: 60,
  degreeNormalize: false,
  relationPriors: undefined,
  userId: undefined,
  scene: undefined,
  diversityThreshold: 0.95,
  diversityKinds: ['semantic', 'procedural'],
};


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
    const bump = (
      node: MemoryNode,
      act: number,
      combine = 'max' as 'max' | 'add',
      path?: Activated['path'],
    ) => {
      const prev = byId.get(node.id);
      if (combine === 'add' && prev) {
        prev.activation = Math.min(1.5, prev.activation + act);
        if (!prev.path && path) prev.path = path;
      } else if (!prev || act > prev.activation) {
        byId.set(node.id, { node, activation: act, path });
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
      for (const { node, activation, path } of current.values()) {
        const edges = await store.getEdges(node.id);
        const degreeFactor = opts.degreeNormalize
          ? 1 / Math.sqrt(Math.max(1, edges.length))
          : 1;
        for (const edge of edges) {
          if (next.has(edge.to)) continue;
          const pathStep = {
            from: node.id,
            to: edge.to,
            type: edge.type,
            weight: edge.weight,
          };
          // An already-activated node does not gain activation twice, but it
          // may still gain the typed path that explains why it lit up.
          if (byId.has(edge.to)) {
            const existing = byId.get(edge.to)!;
            if (!existing.path) existing.path = [...(path ?? []), pathStep];
            continue;
          }
          const neighbor = await store.getNode(edge.to);
          if (!neighbor || neighbor.quarantined || neighbor.strength < 0.05) continue;
          if (opts.userId !== undefined && (neighbor.userId ?? 'default') !== opts.userId) continue;
          // Version edges connect a current record to its retired ancestors;
          // spreading activation must not resurrect them into context.
          if (neighbor.isLatest === false) continue;
          if (!temporalOk(neighbor)) continue;
          const prior = opts.relationPriors?.[edge.type] ?? 1;
          const act =
            activation *
            edge.weight *
            prior *
            degreeFactor *
            Math.pow(opts.spreadingDecay, depth);
          if (act >= opts.primedFloor) {
            next.set(neighbor.id, {
              node: neighbor,
              activation: act,
              path: [...(path ?? []), pathStep],
            });
          }
        }
      }
      for (const a of next.values()) {
        bump(a.node, a.activation, 'add', a.path);
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
    const scoringFilter = {
      excludeQuarantined: true,
      minStrength: 0.05,
      userId: opts.userId,
      asOf: opts.asOf,
      createdAfter: opts.createdAfter,
    };
    const scoringNodes =
      opts.lexicalWeight > 0 || opts.tagWeight > 0
        ? store.listNodesForScoring
          ? await store.listNodesForScoring(scoringFilter)
          : await store.listNodes(scoringFilter)
        : [];
    let lexicalRanked: string[] = [];
    let tagRanked: string[] = [];

    if (opts.lexicalWeight > 0) {
      const lexicalStarted = performance.now();
      if (this.tokenCache.size > 20_000) this.tokenCache.clear();
      const hits = bm25Rank(
        scoringNodes.map((node) => {
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
      lexicalRanked = [...hits]
        .filter(
          (hit) =>
            hit.normalized >= opts.lexicalMinScore &&
            hit.matchedRatio >= opts.lexicalMinCoverage,
        )
        .sort((a, b) => b.score - a.score)
        .map((hit) => hit.id);
      const byNodeId = new Map(scoringNodes.map((node) => [node.id, node] as const));
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
      trace('lexical', lexicalStarted, { docs: scoringNodes.length, hits: hits.length });
    }

    // 6. Entity/tag channel: explicit names, identifiers and quoted titles.
    //    This can nominate a memory the vector/lexical channels did not
    //    surface, as long as the entity appears in the query.
    if (opts.tagWeight > 0) {
      const tagStarted = performance.now();
      const queryText = seeds.join(' ');
      let matched = 0;
      const tagScores: Array<{ id: string; score: number }> = [];
      for (const node of scoringNodes) {
        const tags = Array.isArray(node.meta?.['tags'])
          ? (node.meta!['tags'] as unknown[]).filter(
              (tag): tag is string => typeof tag === 'string',
            )
          : [];
        if (tags.length === 0) continue;
        if (fromSameSession(node) || !temporalOk(node)) continue;
        const hits = matchingTags(tags, queryText);
        if (hits.length === 0) continue;
        matched++;
        const overlap = Math.min(1, hits.length / 2);
        tagScores.push({ id: node.id, score: overlap });
        const act =
          opts.tagWeight *
          overlap *
          (0.25 + 0.75 * node.strength) *
          confidenceFactor(node);
        bump(node, act, 'add');
      }
      tagRanked = tagScores.sort((a, b) => b.score - a.score).map((entry) => entry.id);
      trace('tag', tagStarted, { docs: scoringNodes.length, matched });
    }

    // Optional rank fusion: combine channels by rank instead of blending raw
    // scores. A candidate that is good in several channels outranks one that
    // is perfect in a single channel.
    if (opts.fusion === 'rrf') {
      const fusionStarted = performance.now();
      const entries: FusionChannelEntry[] = [];
      const channelIds = new Set<string>();
      const addChannel = (ids: string[], weight: number): void => {
        ids.forEach((id, index) => {
          entries.push({ id, rank: index + 1, weight });
          channelIds.add(id);
        });
      };
      addChannel(semanticHits.map((hit) => hit.node.id), 0.4);
      addChannel(episodicHits.map((hit) => hit.node.id), 0.25);
      addChannel(
        [...skillHits].sort((a, b) => b.similarity - a.similarity).map((hit) => hit.node.id),
        0.15,
      );
      addChannel(lexicalRanked, 0.25);
      addChannel(tagRanked, 0.1);
      const spreadIds = [...byId.values()]
        .filter((activated) => !channelIds.has(activated.node.id))
        .sort((a, b) => b.activation - a.activation)
        .slice(0, 20)
        .map((activated) => activated.node.id);
      addChannel(spreadIds, 0.1);

      const fused = reciprocalRankFusion(entries, opts.rrfK);
      if (fused.length > 0) {
        const nodesById = new Map<string, MemoryNode>();
        for (const activated of byId.values()) nodesById.set(activated.node.id, activated.node);
        for (const node of scoringNodes) nodesById.set(node.id, node);
        byId.clear();
        for (const result of fused) {
          const node = nodesById.get(result.id);
          if (!node) continue;
          byId.set(result.id, {
            node,
            activation:
              result.normalized *
              (0.25 + 0.75 * node.strength) *
              confidenceFactor(node),
          });
        }
      }
      trace('fusion', fusionStarted, {
        mode: 'rrf',
        channels: 6,
        candidates: fused.length,
      });
    }

    // 7. Episode support: memories from the same discussion reinforce each
    //    other, so resuming a topic surfaces the surrounding context rather
    //    than one isolated line (Hy-Memory's episode channel).
    if (opts.episodeWeight > 0) {
      const episodeStarted = performance.now();
      const anchors = new Set<string>();
      const top = [...byId.values()]
        .sort((a, b) => b.activation - a.activation)
        .slice(0, 1);
      for (const activated of top) {
        const episodeId = activated.node.episodeId;
        if (episodeId) anchors.add(episodeId);
      }
      let boosted = 0;
      for (const activated of byId.values()) {
        const episodeId = activated.node.episodeId;
        if (!episodeId || !anchors.has(episodeId)) continue;
        // Anchor on the strongest hits' discussion: resuming a topic should
        // bring its surrounding context, not reward whichever cluster is
        // largest.
        activated.activation = Math.min(1.5, activated.activation + opts.episodeWeight * 0.5);
        boosted++;
      }
      trace('episode', episodeStarted, { anchors: anchors.size, boosted });
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
        relationPath: a.path,
        userId: a.node.userId ?? 'default',
        episodeId: a.node.episodeId,
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
    const { selected, deferred } = selectActivated(ranked, {
      capacity: opts.capacity,
      diversityThreshold: opts.diversityThreshold,
      diversityKinds: opts.diversityKinds,
      maxPerKind: opts.maxPerKind,
      reservedKinds: opts.reservedKinds,
    });

    trace('dedup', dedupStarted, {
      selected: selected.length,
      deferred: deferred.length,
      capacity: opts.capacity,
      reserved: opts.reservedKinds?.length ?? 0,
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
