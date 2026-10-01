import { createClient, type Client } from '@libsql/client';
import {
  cosineSimilarity,
  type Association,
  type Journal,
  type JournalEvent,
  type JournalEventType,
  type MemoryNode,
  type MemoryNodeFilter,
  type MemoryStore,
  type Provenance,
  type ScoredNode,
  type TaskTrace,
  type TraceStore,
} from '@dream/core';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  scope TEXT NOT NULL,
  content TEXT NOT NULL,
  embedding BLOB NOT NULL,
  importance REAL NOT NULL,
  strength REAL NOT NULL,
  created_at INTEGER NOT NULL,
  last_accessed_at INTEGER NOT NULL,
  labile_until INTEGER,
  consolidated_at INTEGER,
  version INTEGER NOT NULL,
  quarantined INTEGER NOT NULL DEFAULT 0,
  provenance TEXT NOT NULL,
  meta TEXT
);
CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes(kind);
CREATE TABLE IF NOT EXISTS edges (
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  type TEXT NOT NULL,
  weight REAL NOT NULL,
  PRIMARY KEY (from_id, to_id, type)
);
CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_id);
CREATE TABLE IF NOT EXISTS journal (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  node_id TEXT,
  version INTEGER,
  content_hash TEXT,
  meta TEXT
);
CREATE TABLE IF NOT EXISTS traces (
  id TEXT PRIMARY KEY,
  task_type TEXT NOT NULL,
  steps TEXT NOT NULL,
  outcome TEXT NOT NULL,
  ts INTEGER NOT NULL,
  session_id TEXT,
  percept TEXT
);
CREATE INDEX IF NOT EXISTS idx_traces_task ON traces(task_type);
`;

function toBlob(embedding: number[]): Uint8Array {
  const f32 = new Float32Array(embedding);
  return new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
}

function fromBlob(blob: unknown): number[] {
  // @libsql/client returns BLOBs as ArrayBuffer (not Uint8Array).
  let bytes: Uint8Array;
  if (blob instanceof ArrayBuffer) {
    bytes = new Uint8Array(blob);
  } else if (blob instanceof Uint8Array) {
    bytes = blob;
  } else if (Array.isArray(blob)) {
    bytes = new Uint8Array(blob);
  } else {
    bytes = new Uint8Array(0);
  }
  const f32 = new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));
  return Array.from(f32);
}

interface NodeRow {
  id: string;
  kind: MemoryNode['kind'];
  scope: MemoryNode['scope'];
  content: string;
  embedding: unknown;
  importance: number;
  strength: number;
  created_at: number;
  last_accessed_at: number;
  labile_until: number | null;
  consolidated_at: number | null;
  version: number;
  quarantined: number;
  provenance: string;
  meta: string | null;
}

function rowToNode(row: NodeRow): MemoryNode {
  return {
    id: row.id,
    kind: row.kind,
    scope: row.scope,
    content: row.content,
    embedding: fromBlob(row.embedding),
    edges: [],
    provenance: JSON.parse(row.provenance) as Provenance,
    importance: row.importance,
    strength: row.strength,
    createdAt: row.created_at,
    lastAccessedAt: row.last_accessed_at,
    labileUntil: row.labile_until ?? undefined,
    consolidatedAt: row.consolidated_at ?? undefined,
    version: row.version,
    quarantined: row.quarantined === 1,
    meta: row.meta ? (JSON.parse(row.meta) as Record<string, unknown>) : undefined,
  };
}

/**
 * SQLite persistence for the unified memory space. Local-first by design:
 * the whole memory system is a single file the user owns, can inspect, back
 * up, and delete.
 *
 * Vector search is a filtered brute-force scan over normalized embeddings —
 * correct and dependency-free at personal-agent scale (10^4-10^5 nodes).
 * The upgrade path is sqlite-vec virtual tables behind the same interface.
 */
export class SqliteStore implements MemoryStore, TraceStore, Journal {
  private client: Client;
  private readonly ownsClient: boolean;

  constructor(clientOrPath: Client | string) {
    if (typeof clientOrPath === 'string') {
      const url = clientOrPath.startsWith('file:')
        ? clientOrPath
        : `file:${clientOrPath.replace(/\\/g, '/')}`;
      this.client = createClient({ url });
      this.ownsClient = true;
    } else {
      this.client = clientOrPath;
      this.ownsClient = false;
    }
  }

  async init(): Promise<this> {
    await this.client.executeMultiple(SCHEMA);
    // Migration: older databases lack the traces.percept column (added for
    // skill slot mining). Duplicate-column errors are expected and ignored.
    try {
      await this.client.executeMultiple('ALTER TABLE traces ADD COLUMN percept TEXT');
    } catch {
      // column already exists
    }
    return this;
  }

  async close(): Promise<void> {
    if (this.ownsClient) await this.client.close();
  }

  // -------------------------------------------------------------------------
  // MemoryStore
  // -------------------------------------------------------------------------

  async putNode(node: MemoryNode): Promise<void> {
    await this.client.execute({
      sql: `INSERT INTO nodes (id, kind, scope, content, embedding, importance, strength,
              created_at, last_accessed_at, labile_until, consolidated_at, version,
              quarantined, provenance, meta)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              kind=excluded.kind, scope=excluded.scope, content=excluded.content,
              embedding=excluded.embedding, importance=excluded.importance,
              strength=excluded.strength, created_at=excluded.created_at,
              last_accessed_at=excluded.last_accessed_at, labile_until=excluded.labile_until,
              consolidated_at=excluded.consolidated_at, version=excluded.version,
              quarantined=excluded.quarantined, provenance=excluded.provenance, meta=excluded.meta`,
      args: [
        node.id, node.kind, node.scope, node.content, toBlob(node.embedding),
        node.importance, node.strength, node.createdAt, node.lastAccessedAt,
        node.labileUntil ?? null, node.consolidatedAt ?? null, node.version,
        node.quarantined ? 1 : 0, JSON.stringify(node.provenance),
        node.meta ? JSON.stringify(node.meta) : null,
      ],
    });
  }

  async getNode(id: string): Promise<MemoryNode | null> {
    const res = await this.client.execute({ sql: 'SELECT * FROM nodes WHERE id = ?', args: [id] });
    if (res.rows.length === 0) return null;
    return rowToNode(res.rows[0] as unknown as NodeRow);
  }

  async deleteNode(id: string): Promise<boolean> {
    const res = await this.client.execute({ sql: 'DELETE FROM nodes WHERE id = ?', args: [id] });
    return res.rowsAffected > 0;
  }

  private filterSql(filter?: MemoryNodeFilter): { where: string; args: unknown[] } {
    const clauses: string[] = [];
    const args: unknown[] = [];
    if (filter?.kinds && filter.kinds.length > 0) {
      clauses.push(`kind IN (${filter.kinds.map(() => '?').join(',')})`);
      args.push(...filter.kinds);
    }
    if (filter?.scope) {
      clauses.push('scope = ?');
      args.push(filter.scope);
    }
    if (filter?.minStrength !== undefined) {
      clauses.push('strength >= ?');
      args.push(filter.minStrength);
    }
    if (filter?.excludeQuarantined) {
      clauses.push('quarantined = 0');
    }
    return { where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', args };
  }

  async listNodes(filter?: MemoryNodeFilter): Promise<MemoryNode[]> {
    const { where, args } = this.filterSql(filter);
    const res = await this.client.execute({
      sql: `SELECT * FROM nodes ${where}`,
      args: args as never[],
    });
    const nodes = res.rows.map((r) => rowToNode(r as unknown as NodeRow));
    // Edges are fetched per node; personal-agent scale keeps this cheap.
    for (const node of nodes) {
      node.edges = await this.getEdges(node.id);
    }
    return nodes;
  }

  async addEdge(fromId: string, edge: Association): Promise<void> {
    await this.client.execute({
      sql: 'INSERT OR IGNORE INTO edges (from_id, to_id, type, weight) VALUES (?, ?, ?, ?)',
      args: [fromId, edge.to, edge.type, edge.weight],
    });
  }

  async getEdges(fromId: string, type?: Association['type']): Promise<Association[]> {
    const res = type
      ? await this.client.execute({
          sql: 'SELECT to_id, type, weight FROM edges WHERE from_id = ? AND type = ?',
          args: [fromId, type],
        })
      : await this.client.execute({
          sql: 'SELECT to_id, type, weight FROM edges WHERE from_id = ?',
          args: [fromId],
        });
    return res.rows.map((r) => ({
      to: r.to_id as string,
      type: r.type as Association['type'],
      weight: r.weight as number,
    }));
  }

  async searchByEmbedding(
    query: number[],
    k: number,
    filter?: MemoryNodeFilter,
  ): Promise<ScoredNode[]> {
    const { where, args } = this.filterSql(filter);
    const res = await this.client.execute({
      sql: 'SELECT * FROM nodes ' + where,
      args: args as never[],
    });
    const scored = res.rows
      .map((r) => r as unknown as NodeRow)
      .map((row) => ({
        node: rowToNode(row),
        similarity: cosineSimilarity(query, fromBlob(row.embedding)),
      }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, k);
    for (const s of scored) {
      s.node.edges = await this.getEdges(s.node.id);
    }
    return scored;
  }

  // -------------------------------------------------------------------------
  // TraceStore
  // -------------------------------------------------------------------------

  async appendTrace(trace: TaskTrace): Promise<void> {
    await this.client.execute({
      sql: `INSERT OR REPLACE INTO traces (id, task_type, steps, outcome, ts, session_id, percept)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [trace.id, trace.taskType, JSON.stringify(trace.steps), trace.outcome, trace.ts, trace.sessionId ?? null, trace.percept ?? null],
    });
  }

  async listTraces(taskType?: string): Promise<TaskTrace[]> {
    const res = taskType
      ? await this.client.execute({
          sql: 'SELECT * FROM traces WHERE task_type = ? ORDER BY ts',
          args: [taskType],
        })
      : await this.client.execute({ sql: 'SELECT * FROM traces ORDER BY ts', args: [] });
    return res.rows.map((r) => {
      const row = r as unknown as {
        id: string; task_type: string; steps: string; outcome: string; ts: number; session_id: string | null; percept: string | null;
      };
      return {
        id: row.id,
        taskType: row.task_type,
        steps: JSON.parse(row.steps) as TaskTrace['steps'],
        outcome: row.outcome as TaskTrace['outcome'],
        ts: row.ts,
        sessionId: row.session_id ?? undefined,
        percept: row.percept ?? undefined,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Journal (append-only, tombstone-capable)
  // -------------------------------------------------------------------------

  async append(event: Omit<JournalEvent, 'seq'>): Promise<void> {
    await this.client.execute({
      sql: 'INSERT INTO journal (ts, type, node_id, version, content_hash, meta) VALUES (?, ?, ?, ?, ?, ?)',
      args: [
        event.ts,
        event.type,
        event.nodeId ?? null,
        event.version ?? null,
        event.contentHash ?? null,
        event.meta ? JSON.stringify(event.meta) : null,
      ],
    });
  }

  async list(): Promise<JournalEvent[]> {
    const res = await this.client.execute({ sql: 'SELECT * FROM journal ORDER BY seq', args: [] });
    return res.rows.map((r) => {
      const row = r as unknown as {
        seq: number; ts: number; type: string; node_id: string | null;
        version: number | null; content_hash: string | null; meta: string | null;
      };
      return {
        seq: row.seq,
        ts: row.ts,
        type: row.type as JournalEventType,
        nodeId: row.node_id ?? undefined,
        version: row.version ?? undefined,
        contentHash: row.content_hash ?? undefined,
        meta: row.meta ? (JSON.parse(row.meta) as Record<string, unknown>) : undefined,
      };
    });
  }
}
