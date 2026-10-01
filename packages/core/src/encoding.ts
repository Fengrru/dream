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
}

/**
 * The encoding gate is the single entry into long-term memory. It deepens the
 * raw chunk (novelty scoring, association to existing memories — "elaborative
 * rehearsal"), binds provenance, and assigns importance. Everything entering
 * LTM passes through here; the kernel wraps this with the policy pipeline.
 */
export class EncodingGate {
  constructor(
    private readonly store: MemoryStore,
    private readonly journal: Journal,
    private readonly provider: EmbeddingProvider,
    private readonly scorer: ImportanceScorer = new HeuristicImportanceScorer(),
    private readonly now: () => number = Date.now,
  ) {}

  async encode(candidate: ChunkCandidate, options: EncodeOptions = {}): Promise<MemoryNode | null> {
    if (candidate.kind === 'intention') return null;

    const embedding = (await this.provider.embed([candidate.content]))[0]!;
    const nearest = await this.store.searchByEmbedding(embedding, 3, {
      excludeQuarantined: true,
    });
    const novelty = nearest.length === 0 ? 1 : 1 - Math.max(...nearest.map((n) => n.similarity));
    const hasAffect = AFFECT_LEXICON.some((w) =>
      new RegExp(`\\b${w}\\b`, 'i').test(candidate.content),
    );
    const importance = this.scorer.score({ candidate, novelty, hasAffect });

    const kind: MemoryKind = candidate.explicitFact ? 'semantic' : 'episodic';
    const source: ProvenanceSource =
      candidate.source === 'user' ? 'user' : candidate.source === 'tool' ? 'tool' : 'inference';

    const t = this.now();
    const node: MemoryNode = {
      id: newId('mem'),
      kind,
      scope: 'user',
      content: candidate.content,
      embedding,
      edges: [],
      provenance: { source, sessionId: options.sessionId, trust: source === 'user' ? 1 : 0.8 },
      importance,
      strength: 1,
      createdAt: t,
      lastAccessedAt: t,
      version: 1,
      quarantined: candidate.meta?.quarantined === true,
      meta: { ...(candidate.meta ?? {}) },
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
