import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@libsql/client';
import { afterEach, describe, expect, it } from 'vitest';
import { HashingEmbeddingProvider, type MemoryNode } from '@dream/core';
import { SqliteStore } from '../src';

const provider = new HashingEmbeddingProvider();

function makeNode(id: string, content: string, overrides: Partial<MemoryNode> = {}): MemoryNode {
  return {
    id,
    kind: 'episodic',
    scope: 'user',
    content,
    embedding: [1, 0, 0],
    edges: [],
    provenance: { source: 'user', trust: 1 },
    importance: 0.5,
    strength: 1,
    createdAt: 1,
    lastAccessedAt: 1,
    version: 1,
    ...overrides,
  };
}

const stores: SqliteStore[] = [];
const dirs: string[] = [];

async function freshStore(): Promise<SqliteStore> {
  const dir = mkdtempSync(join(tmpdir(), 'dream-sqlite-'));
  dirs.push(dir);
  const store = await new SqliteStore(join(dir, 'memory.db')).init();
  stores.push(store);
  return store;
}

afterEach(async () => {
  for (const store of stores.splice(0)) {
    await store.close(); // release file locks before removing dirs on Windows
  }
  // libsql's background worker releases file locks asynchronously; retry.
  for (const dir of dirs.splice(0)) {
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
  }
});

describe('SqliteStore', () => {
  it('round-trips nodes with embeddings, provenance, meta and optionals', async () => {
    const store = await freshStore();
    const [emb] = await provider.embed(['persist me please']);
    await store.putNode(makeNode('n1', 'persist me please', {
      embedding: emb!,
      kind: 'semantic',
      labileUntil: 123,
      consolidatedAt: 456,
      quarantined: true,
      provenance: { source: 'dream', sessionId: 's1', trust: 0.7 },
      meta: { taskType: 'demo' },
    }));

    const node = await store.getNode('n1');
    expect(node).not.toBeNull();
    expect(node!.kind).toBe('semantic');
    expect(node!.content).toBe('persist me please');
    expect(node!.embedding.length).toBe(emb!.length);
    expect(node!.labileUntil).toBe(123);
    expect(node!.consolidatedAt).toBe(456);
    expect(node!.quarantined).toBe(true);
    expect(node!.provenance.source).toBe('dream');
    expect(node!.meta).toEqual({ taskType: 'demo' });

    expect(await store.deleteNode('n1')).toBe(true);
    expect(await store.getNode('n1')).toBeNull();
  });

  it('filters listNodes and ranks searchByEmbedding like the in-memory store', async () => {
    const store = await freshStore();
    const [a] = await provider.embed(['my sisters name is ada']);
    const [b] = await provider.embed(['quarterly revenue report numbers']);
    await store.putNode(makeNode('a', 'ada', { embedding: a!, quarantined: true }));
    await store.putNode(makeNode('b', 'revenue', { embedding: b! }));

    const clean = await store.listNodes({ excludeQuarantined: true });
    expect(clean.map((n) => n.id)).toEqual(['b']);

    const [q] = await provider.embed(['ada my sisters name']);
    const hits = await store.searchByEmbedding(q!, 2, { excludeQuarantined: true });
    expect(hits[0]!.node.id).toBe('b');
  });

  it('edges dedupe and filter by type', async () => {
    const store = await freshStore();
    await store.putNode(makeNode('a', 'a'));
    await store.putNode(makeNode('b', 'b'));
    await store.addEdge('a', { to: 'b', type: 'similar', weight: 0.9 });
    await store.addEdge('a', { to: 'b', type: 'similar', weight: 0.8 }); // ignored
    expect((await store.getEdges('a')).length).toBe(1);
    expect((await store.getEdges('a', 'causal')).length).toBe(0);
  });

  it('migrates a pre-version-chain database in place', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dream-sqlite-old-'));
    dirs.push(dir);
    const path = join(dir, 'old.db');
    const client = createClient({ url: `file:${path.replace(/\\/g, '/')}` });
    await client.executeMultiple(`
      CREATE TABLE nodes (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, scope TEXT NOT NULL,
        content TEXT NOT NULL, embedding BLOB NOT NULL, importance REAL NOT NULL,
        strength REAL NOT NULL, created_at INTEGER NOT NULL, last_accessed_at INTEGER NOT NULL,
        labile_until INTEGER, consolidated_at INTEGER, version INTEGER NOT NULL,
        quarantined INTEGER NOT NULL DEFAULT 0, provenance TEXT NOT NULL, meta TEXT
      );
    `);
    const embedding = new Uint8Array(new Float32Array([1, 0, 0]).buffer);
    await client.execute({
      sql: `INSERT INTO nodes (id, kind, scope, content, embedding, importance, strength,
              created_at, last_accessed_at, version, quarantined, provenance)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        'legacy', 'semantic', 'user', 'legacy memory', embedding, 0.5, 1,
        1, 1, 1, 0, JSON.stringify({ source: 'user', trust: 1 }),
      ],
    });
    await client.close();

    const store = await new SqliteStore(path).init();
    stores.push(store);
    const node = await store.getNode('legacy');
    expect(node).not.toBeNull();
    expect(node!.isLatest).toBe(true);
    expect(node!.content).toBe('legacy memory');
    expect(await store.listNodes()).toHaveLength(1);
  });

  it('persists version-chain fields and hides superseded records by default', async () => {
    const store = await freshStore();
    const [embedding] = await provider.embed(['swim class moved']);
    await store.putNode(
      makeNode('old', 'swim class at 4pm', {
        embedding: embedding!,
        isLatest: false,
        supersededBy: 'new',
      }),
    );
    await store.putNode(
      makeNode('new', 'swim class at 5pm', {
        embedding: embedding!,
        version: 2,
        isLatest: true,
        supersedes: ['old'],
      }),
    );

    expect((await store.listNodes()).map((node) => node.id)).toEqual(['new']);
    const history = await store.listNodes({ includeSuperseded: true });
    expect(history.map((node) => node.id).sort()).toEqual(['new', 'old']);
    const current = await store.searchByEmbedding(embedding!, 10);
    expect(current.map((hit) => hit.node.id)).toEqual(['new']);
    const loaded = await store.getNode('new');
    expect(loaded!.supersedes).toEqual(['old']);
    expect(loaded!.isLatest).toBe(true);
    const raw = await store.listNodesForScoring();
    expect(raw.every((node) => node.edges.length === 0)).toBe(true);
  });

  it('filters by owner partition and persists revision chains', async () => {
    const store = await freshStore();
    await store.putNode(makeNode('a', 'alice preference', { userId: 'alice' }));
    await store.putNode(makeNode('b', 'bob preference', { userId: 'bob' }));
    expect((await store.listNodes({ userId: 'alice' })).map((node) => node.id)).toEqual(['a']);
    expect((await store.listNodes({ userId: 'bob' })).map((node) => node.id)).toEqual(['b']);

    const first = await store.appendRevision({
      artifactKey: 'src/a.ts',
      tool: 'apply_patch',
      ts: 1,
      oldContent: 'x',
      newContent: 'y',
      diff: '- x\n+ y',
    });
    const second = await store.appendRevision({
      artifactKey: 'src/a.ts',
      tool: 'apply_patch',
      ts: 2,
      oldContent: 'y',
      newContent: 'z',
      diff: '- y\n+ z',
    });
    expect(first.version).toBe(1);
    expect(second.version).toBe(2);
    const chain = await store.listRevisions('src/a.ts');
    expect(chain.map((revision) => revision.version)).toEqual([1, 2]);
    expect(chain[1]!.diff).toContain('+ z');
  });

  it('persists temporal validity, evidence and confidence and filters as-of', async () => {
    const store = await freshStore();
    await store.putNode(
      makeNode('old', 'meeting at 3pm', {
        validFrom: 100,
        validUntil: 200,
        eventTime: 150,
        evidenceCount: 3,
        confidence: 0.7,
      }),
    );
    await store.putNode(
      makeNode('new', 'meeting at 5pm', {
        validFrom: 200,
        validUntil: 300,
        eventTime: 250,
        evidenceCount: 2,
        confidence: 0.9,
      }),
    );
    expect((await store.listNodes({ asOf: 150 })).map((node) => node.id)).toEqual(['old']);
    expect((await store.listNodes({ asOf: 250 })).map((node) => node.id)).toEqual(['new']);
    const loaded = await store.getNode('old');
    expect(loaded!.eventTime).toBe(150);
    expect(loaded!.evidenceCount).toBe(3);
    expect(loaded!.confidence).toBe(0.7);
    expect((await store.listNodes({ createdAfter: 2 })).length).toBe(0);
  });

  it('journals append-only with sequence numbers; traces filter by task type', async () => {
    const store = await freshStore();
    await store.append({ ts: 1, type: 'encode', nodeId: 'x', contentHash: 'h1' });
    await store.append({ ts: 2, type: 'purge', nodeId: 'x' });
    const events = await store.list();
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
    expect(events[1]!.type).toBe('purge');

    await store.appendTrace({ id: 't1', taskType: 'analyze-data', steps: [], outcome: 'success', ts: 1 });
    await store.appendTrace({ id: 't2', taskType: 'other', steps: [], outcome: 'failure', ts: 2 });
    expect((await store.listTraces('analyze-data')).map((t) => t.id)).toEqual(['t1']);
    expect((await store.listTraces()).length).toBe(2);
  });
});
