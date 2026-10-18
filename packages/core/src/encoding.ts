import type {
  ChunkCandidate,
  Journal,
  MemoryKind,
  MemoryNode,
  MemoryStore,
  ProvenanceSource,
} from './types';
import type { EmbeddingProvider } from './embeddings';
import { newId, sha256Hex, clamp } from './ids';
import { extractEntityTags } from './entities';

const AFFECT_LEXICON = [
  'love', 'hate', 'urgent', 'critical', 'important', 'terrible', 'amazing',
  'asap', 'must', 'never', 'always', 'afraid', 'worried', 'excited', 'angry',
];

export interface ImportanceInput {
  candidate: ChunkCandidate;
  /** 1 - cosine to the nearest existing memory; 1 means fully novel. */
  novelty: number;
  hasAffect: boolean;
}

export interface ImportanceScorer {
  score(input: ImportanceInput): number;
}

/**
 * Heuristic v1 scorer. Deliberately transparent: novelty, explicitness,
 * source and affect. Swap with an LLM scorer via the same interface.
 */
export class HeuristicImportanceScorer implements ImportanceScorer {
  score({ candidate, novelty, hasAffect }: ImportanceInput): number {
    let score = 0.35 * clamp(novelty, 0, 1);
    if (candidate.explicitFact) score += 0.3;
    score += candidate.source === 'user' ? 0.2 : 0.05;
    if (hasAffect) score += 0.15;
    return clamp(score, 0.05, 1);
  }
}

export interface EncodeOptions {
  sessionId?: string;
  /** Owner partition; undefined = 'default'. */
  userId?: string;
  /** Default scene tag when the candidate does not carry one. */
  scene?: string;
}

/**
 * The encoding gate is the single entry into long-term memory. It deepens the
 * raw chunk (novelty scoring, association to existing memories — "elaborative
 * rehearsal"), binds provenance, and assigns importance. Everything entering
 * LTM passes through here; the kernel wraps this with the policy pipeline.
 */
export class EncodingGate {
  private currentEpisodeId?: string;
  private episodeLastAt = 0;

  constructor(
    private readonly store: MemoryStore,
    private readonly journal: Journal,
    private readonly provider: EmbeddingProvider,
    private readonly scorer: ImportanceScorer = new HeuristicImportanceScorer(),
    private readonly now: () => number = Date.now,
    /** Inactivity gap that starts a new discussion episode. */
    private readonly episodeGapMs: number = 30 * 60 * 1000,
  ) {}

  private nextEpisodeId(now: number): string {
    if (this.currentEpisodeId === undefined || now - this.episodeLastAt > this.episodeGapMs) {
      this.currentEpisodeId = newId('ep');
    }
    this.episodeLastAt = now;
    return this.currentEpisodeId;
  }

  async encode(candidate: ChunkCandidate, options: EncodeOptions = {}): Promise<MemoryNode | null> {
    const embedding = (await this.provider.embed([candidate.content]))[0]!;
    const nearest = await this.store.searchByEmbedding(embedding, 3, {
      excludeQuarantined: true,
      userId: options.userId,
    });
    const novelty = nearest.length === 0 ? 1 : 1 - Math.max(...nearest.map((n) => n.similarity));
    const hasAffect = AFFECT_LEXICON.some((w) =>
      new RegExp(`\\b${w}\\b`, 'i').test(candidate.content),
    );
    const importance = this.scorer.score({ candidate, novelty, hasAffect });

    // Intentions are prospective semantic records with an expiry; they are not
    // a fifth memory kind (the unified space keeps four).
    const isIntention = candidate.kind === 'intention';
    const kind: MemoryKind = candidate.explicitFact || isIntention ? 'semantic' : 'episodic';
    const source: ProvenanceSource =
      candidate.source === 'user' ? 'user' : candidate.source === 'tool' ? 'tool' : 'inference';

    const metaTags = Array.isArray(candidate.meta?.['tags'])
      ? (candidate.meta!['tags'] as unknown[]).filter((tag): tag is string => typeof tag === 'string')
      : [];
    const tags = [
      ...new Set([...(candidate.tags ?? []), ...metaTags, ...extractEntityTags(candidate.content)]),
    ].slice(0, 16);

    const t = this.now();
    const node: MemoryNode = {
      id: newId('mem'),
      kind,
      scope: 'user',
      userId: options.userId ?? 'default',
      episodeId: candidate.episodeId ?? this.nextEpisodeId(t),
      content: candidate.content,
      embedding,
      edges: [],
      provenance: { source, sessionId: options.sessionId, trust: source === 'user' ? 1 : 0.8 },
      importance,
      strength: 1,
      createdAt: t,
      lastAccessedAt: t,
      eventTime: candidate.eventTime,
      validFrom: candidate.validFrom ?? t,
      validUntil: candidate.validUntil,
      evidenceCount: candidate.evidenceCount ?? 1,
      confidence: candidate.confidence ?? 1,
      version: 1,
      quarantined: candidate.meta?.quarantined === true,
      meta: {
        ...(candidate.meta ?? {}),
        ...(candidate.details !== undefined ? { details: candidate.details } : {}),
        ...((candidate.scene ?? options.scene)
          ? { scene: candidate.scene ?? options.scene }
          : {}),
        ...(isIntention ? { intention: true } : {}),
        ...(candidate.expiresAt !== undefined ? { expiresAt: candidate.expiresAt } : {}),
        ...(tags.length > 0 ? { tags } : {}),
      },
    };

    await this.store.putNode(node);

    // Elaborative rehearsal: associate with the most similar existing memories.
    for (const hit of nearest) {
      if (hit.similarity < 0.45) continue;
      await this.store.addEdge(node.id, { to: hit.node.id, type: 'similar', weight: hit.similarity });
      await this.store.addEdge(hit.node.id, { to: node.id, type: 'similar', weight: hit.similarity });
    }

    await this.journal.append({
      ts: t,
      type: 'encode',
      nodeId: node.id,
      version: 1,
      contentHash: sha256Hex(node.content),
      meta: { importance, kind, novelty },
    });

    return node;
  }
}
