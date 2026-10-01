import type { MemoryNode, MemoryStore } from './types';
import type { EmbeddingProvider } from './embeddings';
import { clamp, newId, sha256Hex } from './ids';

type SelfType = 'expertise' | 'known-unknown' | 'opinion' | 'identity';

interface SelfMeta extends Record<string, unknown> {
  selfType: SelfType;
  domain: string;
  score?: number;
  position?: string;
}

/**
 * The self-model is Dream's memory about itself: what it is good at, what it
 * knows it does not know, what it believes. It is stored in the same unified
 * memory space (kind: 'self', scope: 'agent') and evolves with experience, so
 * Dream is the same entity in every session, not a persona assembled per chat.
 */
export class SelfModelManager {
  constructor(
    private readonly store: MemoryStore,
    private readonly provider: EmbeddingProvider,
    private readonly journal: { append(event: { ts: number; type: 'self'; nodeId?: string; version?: number; contentHash?: string; meta?: Record<string, unknown> }): Promise<void> },
    private readonly now: () => number = Date.now,
  ) {}

  async boostExpertise(domain: string, delta: number): Promise<void> {
    const node = await this.getOrCreate('expertise', domain);
    const meta = node.meta as SelfMeta;
    const score = clamp((meta.score ?? 0.5) + delta, 0, 1);
    node.meta = { ...meta, score };
    node.content = `Expertise: ${domain} (confidence ${score.toFixed(2)})`;
    await this.store.putNode(node);
    await this.journal.append({
      ts: this.now(),
      type: 'self',
      nodeId: node.id,
      version: node.version,
      contentHash: sha256Hex(node.content),
      meta: { domain, score },
    });
  }

  async addKnownUnknown(domain: string): Promise<void> {
    const node = await this.getOrCreate('known-unknown', domain);
    node.content = `Known unknown: ${domain} — needs learning`;
    await this.store.putNode(node);
    await this.journal.append({
      ts: this.now(),
      type: 'self',
      nodeId: node.id,
      contentHash: sha256Hex(node.content),
      meta: { domain },
    });
  }

  async setOpinion(topic: string, position: string, confidence: number): Promise<void> {
    const node = await this.getOrCreate('opinion', topic);
    const meta = node.meta as SelfMeta;
    node.meta = { ...meta, position, score: clamp(confidence, 0, 1) };
    node.content = `On ${topic}: ${position} (confidence ${confidence.toFixed(2)})`;
    await this.store.putNode(node);
  }

  /** Self-knowledge relevant to the current context (injected with recall). */
  async relevantFor(queryEmbedding: number[], k = 4): Promise<MemoryNode[]> {
    const hits = await this.store.searchByEmbedding(queryEmbedding, k, {
      kinds: ['self'],
    });
    return hits.map((h) => h.node);
  }

  /**
   * Prompt-ready summary. Capped at `limit` nodes sorted by importance —
   * the self-model is the only unbounded component of the reasoning prompt
   * (experiment E6), so it must not grow without bound.
   */
  async summarize(limit = 16): Promise<string> {
    const nodes = await this.store.listNodes({ kinds: ['self'] });
    if (nodes.length === 0) return 'No self-knowledge yet.';
    const ranked = [...nodes].sort((a, b) => b.importance - a.importance).slice(0, limit);
    const hidden = nodes.length - ranked.length;
    const lines = ranked.map((n) => `- ${n.content}`);
    if (hidden > 0) lines.push(`- (and ${hidden} more self-notes)`);
    return lines.join('\n');
  }

  private async getOrCreate(selfType: SelfType, domain: string): Promise<MemoryNode> {
    const all = await this.store.listNodes({ kinds: ['self'] });
    const found = all.find((n) => (n.meta as SelfMeta | undefined)?.selfType === selfType && (n.meta as SelfMeta).domain === domain);
    if (found) return found;

    const t = this.now();
    const embedding = (await this.provider.embed([`${selfType} ${domain}`]))[0]!;
    const node: MemoryNode = {
      id: newId('self'),
      kind: 'self',
      scope: 'agent',
      content: `${selfType}: ${domain}`,
      embedding,
      edges: [],
      provenance: { source: 'inference', trust: 0.9 },
      importance: 0.6,
      strength: 1,
      createdAt: t,
      lastAccessedAt: t,
      version: 1,
      meta: { selfType, domain, score: 0.5 } as SelfMeta,
    };
    await this.store.putNode(node);
    return node;
  }
}
