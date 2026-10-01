import { describe, expect, it } from 'vitest';
import { InMemoryStore } from '../src/store';
import { HashingEmbeddingProvider, cosineSimilarity } from '../src/embeddings';
import { sha256Hex } from '../src/ids';

describe('InMemoryStore', () => {
  const provider = new HashingEmbeddingProvider();

  it('round-trips nodes and filters by kind/scope/quarantine', async () => {
    const store = new InMemoryStore();
    const [emb] = await provider.embed(['hello world']);
    await store.putNode({
      id: 'a', kind: 'episodic', scope: 'user', content: 'hello world',
      embedding: emb!, edges: [], provenance: { source: 'user', trust: 1 },
      importance: 0.5, strength: 1, createdAt: 0, lastAccessedAt: 0, version: 1,
    });
    await store.putNode({
      id: 'b', kind: 'semantic', scope: 'agent', content: 'quarantined',
      embedding: emb!, edges: [], provenance: { source: 'inference', trust: 0.2 },
      importance: 0.5, strength: 1, createdAt: 0, lastAccessedAt: 0, version: 1, quarantined: true,
    });

    expect(await store.getNode('a')).not.toBeNull();
    expect(await store.getNode('missing')).toBeNull();

    const episodic = await store.listNodes({ kinds: ['episodic'] });
    expect(episodic.map((n) => n.id)).toEqual(['a']);

    const clean = await store.listNodes({ excludeQuarantined: true });
    expect(clean.map((n) => n.id)).toEqual(['a']);

    expect(await store.deleteNode('a')).toBe(true);
    expect(await store.getNode('a')).toBeNull();
  });

  it('ranks nearest neighbors by cosine similarity', async () => {
    const store = new InMemoryStore();
    const [q] = await provider.embed(['my sisters name is ada']);
    const [near] = await provider.embed(['my sisters name is ada and she is nice']);
    const [far] = await provider.embed(['quarterly revenue increased in q3']);

    await store.putNode(node('near', near!));
    await store.putNode(node('far', far!));

    const hits = await store.searchByEmbedding(q!, 2);
    expect(hits[0]!.node.id).toBe('near');
    expect(hits[0]!.similarity).toBeGreaterThan(hits[1]!.similarity);
    expect(cosineSimilarity(q!, q!)).toBeCloseTo(1);
  });

  it('dedupes symmetric edges and filters by type', async () => {
    const store = new InMemoryStore();
    await store.putNode(node('a', [1, 0]));
    await store.putNode(node('b', [0, 1]));
    await store.addEdge('a', { to: 'b', type: 'similar', weight: 0.9 });
    await store.addEdge('a', { to: 'b', type: 'similar', weight: 0.9 });
    expect((await store.getEdges('a')).length).toBe(1);
    expect((await store.getEdges('a', 'causal')).length).toBe(0);
  });

  it('journals append-only events with sequence numbers', async () => {
    const store = new InMemoryStore();
    await store.append({ ts: 1, type: 'encode', contentHash: sha256Hex('x') });
    await store.append({ ts: 2, type: 'recall', nodeId: 'a' });
    const events = await store.list();
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
    expect(events[0]!.contentHash).toBe(sha256Hex('x'));
  });
});

function node(id: string, embedding: number[]) {
  return {
    id, kind: 'episodic' as const, scope: 'user' as const, content: id,
    embedding, edges: [], provenance: { source: 'user' as const, trust: 1 },
    importance: 0.5, strength: 1, createdAt: 0, lastAccessedAt: 0, version: 1,
  };
}
