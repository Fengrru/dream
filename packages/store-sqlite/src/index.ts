import { createClient, type Client } from '@libsql/client';
import {
  cosineSimilarity,
  newId,
  type Association,
  type Journal,
  type JournalEvent,
  type JournalEventType,
  type MemoryNode,
  type MemoryNodeFilter,
  type MemoryStore,
  type Provenance,
  type RevisionInput,
  type RevisionRecord,
  type RevisionStore,
  type ScoredNode,
  type TaskTrace,
  type TraceStore,
} from '@dream/core';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  scope TEXT NOT NULL,
  user_id TEXT NOT NULL DEFAULT 'default',
  episode_id TEXT,
  idempotency_key TEXT,
  content TEXT NOT NULL,
  embedding BLOB NOT NULL,
  importance REAL NOT NULL,
  strength REAL NOT NULL,
  created_at INTEGER NOT NULL,
  last_accessed_at INTEGER NOT NULL,
  event_time INTEGER,
  valid_from INTEGER,
  valid_until INTEGER,
  evidence_count INTEGER NOT NULL DEFAULT 1,
  confidence REAL NOT NULL DEFAULT 1,
  labile_until INTEGER,
  consolidated_at INTEGER,
  version INTEGER NOT NULL,
  quarantined INTEGER NOT NULL DEFAULT 0,
  is_latest INTEGER NOT NULL DEFAULT 1,
  superseded_by TEXT,
  supersedes TEXT,
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
  percept TEXT,
  environment TEXT,
  fact_ids TEXT
);
CREATE INDEX IF NOT EXISTS idx_traces_task ON traces(task_type);
CREATE TABLE IF NOT EXISTS revisions (
  id TEXT PRIMARY KEY,
  artifact_key TEXT NOT NULL,
  version INTEGER NOT NULL,
  tool TEXT NOT NULL,
  session_id TEXT,
  ts INTEGER NOT NULL,
  old_content TEXT,
  new_content TEXT,
  diff TEXT,
  source_fact_ids TEXT,
  derived_experience_ids TEXT
);
CREATE INDEX IF NOT EXISTS idx_revisions_artifact ON revisions(artifact_key, version);
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
  user_id: string | null;
  episode_id: string | null;
  idempotency_key: string | null;
  content: string;
  embedding: unknown;
  importance: number;
  strength: number;
  created_at: number;
  last_accessed_at: number;
  event_time: number | null;
  valid_from: number | null;
  valid_until: number | null;
  evidence_count: number | null;
  confidence: number | null;
  labile_until: number | null;
  consolidated_at: number | null;
  version: number;
  quarantined: number;
  is_latest: number;
  superseded_by: string | null;
  supersedes: string | null;
  provenance: string;
  meta: string | null;
}

function rowToNode(row: NodeRow): MemoryNode {
  return {
    id: row.id,
    kind: row.kind,
    scope: row.scope,
    userId: row.user_id ?? 'default',
    episodeId: row.episode_id ?? undefined,
    idempotencyKey: row.idempotency_key ?? undefined,
    content: row.content,
    embedding: fromBlob(row.embedding),
    edges: [],
    provenance: JSON.parse(row.provenance) as Provenance,
    importance: row.importance,
    strength: row.strength,
    createdAt: row.created_at,
    lastAccessedAt: row.last_accessed_at,
    eventTime: row.event_time ?? undefined,
    validFrom: row.valid_from ?? undefined,
    validUntil: row.valid_until ?? undefined,
    evidenceCount: row.evidence_count ?? 1,
    confidence: row.confidence ?? 1,
    labileUntil: row.labile_until ?? undefined,
    consolidatedAt: row.consolidated_at ?? undefined,
    version: row.version,
    quarantined: row.quarantined === 1,
    isLatest: row.is_latest !== 0,
    supersededBy: row.superseded_by ?? undefined,
    supersedes: row.supersedes ? (JSON.parse(row.supersedes) as string[]) : undefined,
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
export class SqliteStore implements MemoryStore, TraceStore, Journal, RevisionStore {
  private client: Client;
  private readonly ownsClient: boolean;
  private inTransaction = false;

  /** Local libSQL uses one connection; BEGIN/COMMIT happen on this handle. */
  private get db(): Client {
    return this.client;
  }

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
    await this.db.executeMultiple(SCHEMA);
    // Durable, single-writer friendly defaults. busy_timeout prevents an
    // transient external reader from surfacing SQLITE_BUSY during a write.
    await this.db.executeMultiple(
      'PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;',
    );
    // Migration: older databases lack the traces.percept column (added for
    // skill slot mining). Duplicate-column errors are expected and ignored.
    for (const ddl of [
      'ALTER TABLE traces ADD COLUMN percept TEXT',
      'ALTER TABLE traces ADD COLUMN environment TEXT',
      'ALTER TABLE traces ADD COLUMN fact_ids TEXT',
    ]) {
      try {
        await this.db.executeMultiple(ddl);
      } catch {
        // column already exists
      }
    }
    // Migration: version-chain columns (added with EVOLVE semantics).
    for (const ddl of [
      "ALTER TABLE nodes ADD COLUMN user_id TEXT NOT NULL DEFAULT 'default'",
      'ALTER TABLE nodes ADD COLUMN episode_id TEXT',
      'ALTER TABLE nodes ADD COLUMN idempotency_key TEXT',
      'ALTER TABLE nodes ADD COLUMN event_time INTEGER',
      'ALTER TABLE nodes ADD COLUMN valid_from INTEGER',
      'ALTER TABLE nodes ADD COLUMN valid_until INTEGER',
      'ALTER TABLE nodes ADD COLUMN evidence_count INTEGER NOT NULL DEFAULT 1',
      'ALTER TABLE nodes ADD COLUMN confidence REAL NOT NULL DEFAULT 1',
      'ALTER TABLE nodes ADD COLUMN is_latest INTEGER NOT NULL DEFAULT 1',
      'ALTER TABLE revisions ADD COLUMN source_fact_ids TEXT',
      'ALTER TABLE revisions ADD COLUMN derived_experience_ids TEXT',
      'ALTER TABLE nodes ADD COLUMN superseded_by TEXT',
      'ALTER TABLE nodes ADD COLUMN supersedes TEXT',
    ]) {
      try {
        await this.db.executeMultiple(ddl);
      } catch {
        // column already exists
      }
    }
    // Index after the migration: on an old database the column does not exist
    // until the ALTER above runs.
    await this.db.executeMultiple(
      'CREATE INDEX IF NOT EXISTS idx_nodes_latest ON nodes(is_latest)',
    );
    await this.db.executeMultiple(
      'CREATE INDEX IF NOT EXISTS idx_nodes_idempotency ON nodes(idempotency_key)',
    );
    return this;
  }

  async close(): Promise<void> {
    if (this.inTransaction) {
      await this.client.execute('ROLLBACK').catch(() => undefined);
      this.inTransaction = false;
    }
    if (this.ownsClient) await this.client.close();
  }

  /**
   * Write transaction on the client's single local connection.
   *
   * libSQL's Transaction objects are safe for one-off writes but churning one
   * per encode crashes the Windows native client under bulk writes (E1 found
   * this). BEGIN IMMEDIATE/COMMIT on the same connection keeps the atomicity
   * without the transaction-object lifecycle.
   */
  async runInTransaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inTransaction) return fn();
    this.inTransaction = true;
    await this.client.execute('BEGIN IMMEDIATE');
    try {
      const result = await fn();
      await this.client.execute('COMMIT');
      return result;
    } catch (error) {
      await this.client.execute('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  /** Flush the WAL into the main database before a cold backup. */
  async checkpoint(): Promise<void> {
    if (this.inTransaction) throw new Error('cannot checkpoint during an open transaction');
    await this.client.execute('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  /** Operational health check used by `dream doctor`. */
  async health(): Promise<{
    ok: boolean;
    checks: Array<{ name: string; ok: boolean; detail: string }>;
  }> {
    const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
    const integrity = await this.client.execute('PRAGMA integrity_check');
    const integrityValue = String(integrity.rows[0]?.['integrity_check'] ?? '');
    checks.push({
      name: 'integrity_check',
      ok: integrityValue.toLowerCase() === 'ok',
      detail: integrityValue,
    });

    const journal = await this.client.execute('PRAGMA journal_mode');
    const journalMode = String(journal.rows[0]?.['journal_mode'] ?? '');
    checks.push({
      name: 'journal_mode',
      ok: journalMode.toLowerCase() === 'wal',
      detail: journalMode,
    });

    const columns = await this.client.execute('PRAGMA table_info(nodes)');
    const names = new Set(columns.rows.map((row) => String(row['name'])));
    const required = [
      'user_id',
      'episode_id',
      'idempotency_key',
      'valid_from',
      'valid_until',
      'evidence_count',
      'confidence',
      'is_latest',
      'superseded_by',
      'supersedes',
    ];
    const missing = required.filter((column) => !names.has(column));
    checks.push({
      name: 'schema_columns',
      ok: missing.length === 0,
      detail: missing.length === 0 ? `${names.size} columns` : `missing: ${missing.join(', ')}`,
    });

    const scalar = async (sql: string): Promise<number> => {
      const result = await this.client.execute(sql);
      return Number(result.rows[0]?.['c'] ?? 0);
    };
    const nodes = await scalar('SELECT COUNT(*) AS c FROM nodes');
    const edges = await scalar('SELECT COUNT(*) AS c FROM edges');
    const revisions = await scalar('SELECT COUNT(*) AS c FROM revisions');
    const orphans = await scalar(
      `SELECT COUNT(*) AS c FROM edges e
       LEFT JOIN nodes a ON a.id = e.from_id
       LEFT JOIN nodes b ON b.id = e.to_id
       WHERE a.id IS NULL OR b.id IS NULL`,
    );
    checks.push({ name: 'orphan_edges', ok: orphans === 0, detail: String(orphans) });
    const duplicateKeys = await scalar(
      `SELECT COUNT(*) AS c FROM (
         SELECT idempotency_key FROM nodes
         WHERE idempotency_key IS NOT NULL
         GROUP BY idempotency_key HAVING COUNT(*) > 1
       )`,
    );
    checks.push({
      name: 'duplicate_idempotency_keys',
      ok: duplicateKeys === 0,
      detail: String(duplicateKeys),
    });
    checks.push({
      name: 'counts',
      ok: true,
      detail: `nodes=${nodes}, edges=${edges}, revisions=${revisions}`,
    });

    return { ok: checks.every((check) => check.ok), checks };
  }

  // -------------------------------------------------------------------------
  // MemoryStore
  // -------------------------------------------------------------------------

  async putNode(node: MemoryNode): Promise<void> {
    await this.db.execute({
      sql: `INSERT INTO nodes (id, kind, scope, user_id, episode_id, idempotency_key, content, embedding, importance, strength,
              created_at, last_accessed_at, event_time, valid_from, valid_until, evidence_count,
              confidence, labile_until, consolidated_at, version,
              quarantined, is_latest, superseded_by, supersedes, provenance, meta)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              kind=excluded.kind, scope=excluded.scope, user_id=excluded.user_id,
              episode_id=excluded.episode_id, idempotency_key=excluded.idempotency_key,
              content=excluded.content,
              embedding=excluded.embedding, importance=excluded.importance,
              strength=excluded.strength, created_at=excluded.created_at,
              last_accessed_at=excluded.last_accessed_at, event_time=excluded.event_time,
              valid_from=excluded.valid_from, valid_until=excluded.valid_until,
              evidence_count=excluded.evidence_count, confidence=excluded.confidence,
              labile_until=excluded.labile_until,
              consolidated_at=excluded.consolidated_at, version=excluded.version,
              quarantined=excluded.quarantined, is_latest=excluded.is_latest,
              superseded_by=excluded.superseded_by, supersedes=excluded.supersedes,
              provenance=excluded.provenance, meta=excluded.meta`,
      args: [
        node.id, node.kind, node.scope, node.userId ?? 'default', node.episodeId ?? null,
        node.idempotencyKey ?? null, node.content, toBlob(node.embedding),
        node.importance, node.strength, node.createdAt, node.lastAccessedAt,
        node.eventTime ?? null, node.validFrom ?? null, node.validUntil ?? null,
        node.evidenceCount ?? 1, node.confidence ?? 1,
        node.labileUntil ?? null, node.consolidatedAt ?? null, node.version,
        node.quarantined ? 1 : 0, node.isLatest === false ? 0 : 1,
        node.supersededBy ?? null, node.supersedes ? JSON.stringify(node.supersedes) : null,
        JSON.stringify(node.provenance),
        node.meta ? JSON.stringify(node.meta) : null,
      ],
    });
  }

  async getNode(id: string): Promise<MemoryNode | null> {
    const res = await this.db.execute({ sql: 'SELECT * FROM nodes WHERE id = ?', args: [id] });
    if (res.rows.length === 0) return null;
    return rowToNode(res.rows[0] as unknown as NodeRow);
  }

  async deleteNode(id: string): Promise<boolean> {
    const res = await this.db.execute({ sql: 'DELETE FROM nodes WHERE id = ?', args: [id] });
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
    if (filter?.userId !== undefined) {
      clauses.push("COALESCE(user_id, 'default') = ?");
      args.push(filter.userId);
    }
    if (filter?.createdAfter !== undefined) {
      clauses.push('created_at >= ?');
      args.push(filter.createdAfter);
    }
    if (filter?.episodeId !== undefined) {
      clauses.push('episode_id = ?');
      args.push(filter.episodeId);
    }
    if (filter?.idempotencyKey !== undefined) {
      clauses.push('idempotency_key = ?');
      args.push(filter.idempotencyKey);
    }
    if (filter?.asOf !== undefined) {
      clauses.push('COALESCE(valid_from, -9223372036854775808) <= ?');
      args.push(filter.asOf);
      clauses.push('COALESCE(valid_until, 9223372036854775807) >= ?');
      args.push(filter.asOf);
    }
    if (filter?.minStrength !== undefined) {
      clauses.push('strength >= ?');
      args.push(filter.minStrength);
    }
    if (filter?.excludeQuarantined) {
      clauses.push('quarantined = 0');
    }
    if (!filter?.includeSuperseded) {
      clauses.push('is_latest = 1');
    }
    return { where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', args };
  }

  async listNodes(filter?: MemoryNodeFilter): Promise<MemoryNode[]> {
    const { where, args } = this.filterSql(filter);
    const res = await this.db.execute({
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

  /** Scoring-only listing: skips per-node edge loading (the dominant cost). */
  async listNodesForScoring(filter?: MemoryNodeFilter): Promise<MemoryNode[]> {
    const { where, args } = this.filterSql(filter);
    const res = await this.db.execute({
      sql: `SELECT * FROM nodes ${where}`,
      args: args as never[],
    });
    return res.rows.map((row) => rowToNode(row as unknown as NodeRow));
  }

  async addEdge(fromId: string, edge: Association): Promise<void> {
    await this.db.execute({
      sql: 'INSERT OR IGNORE INTO edges (from_id, to_id, type, weight) VALUES (?, ?, ?, ?)',
      args: [fromId, edge.to, edge.type, edge.weight],
    });
  }

  async getEdges(fromId: string, type?: Association['type']): Promise<Association[]> {
    const res = type
      ? await this.db.execute({
          sql: 'SELECT to_id, type, weight FROM edges WHERE from_id = ? AND type = ?',
          args: [fromId, type],
        })
      : await this.db.execute({
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
    const res = await this.db.execute({
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
    await this.db.execute({
      sql: `INSERT OR REPLACE INTO traces (id, task_type, steps, outcome, ts, session_id, percept, environment, fact_ids)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        trace.id,
        trace.taskType,
        JSON.stringify(trace.steps),
        trace.outcome,
        trace.ts,
        trace.sessionId ?? null,
        trace.percept ?? null,
        trace.environment ?? null,
        trace.factIds ? JSON.stringify(trace.factIds) : null,
      ],
    });
  }

  async listTraces(taskType?: string): Promise<TaskTrace[]> {
    const res = taskType
      ? await this.db.execute({
          sql: 'SELECT * FROM traces WHERE task_type = ? ORDER BY ts',
          args: [taskType],
        })
      : await this.db.execute({ sql: 'SELECT * FROM traces ORDER BY ts', args: [] });
    return res.rows.map((r) => {
      const row = r as unknown as {
        id: string; task_type: string; steps: string; outcome: string; ts: number;
        session_id: string | null; percept: string | null; environment: string | null;
        fact_ids: string | null;
      };
      return {
        id: row.id,
        taskType: row.task_type,
        steps: JSON.parse(row.steps) as TaskTrace['steps'],
        outcome: row.outcome as TaskTrace['outcome'],
        ts: row.ts,
        sessionId: row.session_id ?? undefined,
        percept: row.percept ?? undefined,
        environment: row.environment ?? undefined,
        factIds: row.fact_ids ? (JSON.parse(row.fact_ids) as string[]) : undefined,
      };
    });
  }

  // -------------------------------------------------------------------------
  // RevisionStore
  // -------------------------------------------------------------------------

  async appendRevision(input: RevisionInput): Promise<RevisionRecord> {
    const next = await this.db.execute({
      sql: 'SELECT COALESCE(MAX(version), 0) + 1 AS version FROM revisions WHERE artifact_key = ?',
      args: [input.artifactKey],
    });
    const version = Number(next.rows[0]?.version ?? 1);
    const record: RevisionRecord = { ...input, id: newId('rev'), version };
    await this.db.execute({
      sql: `INSERT INTO revisions (id, artifact_key, version, tool, session_id, ts, old_content, new_content, diff, source_fact_ids, derived_experience_ids)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        record.id,
        record.artifactKey,
        record.version,
        record.tool,
        record.sessionId ?? null,
        record.ts,
        record.oldContent ?? null,
        record.newContent ?? null,
        record.diff ?? null,
        record.sourceFactIds ? JSON.stringify(record.sourceFactIds) : null,
        record.derivedExperienceIds ? JSON.stringify(record.derivedExperienceIds) : null,
      ],
    });
    return record;
  }

  async listRevisions(artifactKey: string): Promise<RevisionRecord[]> {
    const res = await this.db.execute({
      sql: 'SELECT * FROM revisions WHERE artifact_key = ? ORDER BY version',
      args: [artifactKey],
    });
    return res.rows.map((row) => ({
      id: row.id as string,
      artifactKey: row.artifact_key as string,
      version: Number(row.version),
      tool: row.tool as string,
      sessionId: (row.session_id as string | null) ?? undefined,
      ts: Number(row.ts),
      oldContent: (row.old_content as string | null) ?? undefined,
      newContent: (row.new_content as string | null) ?? undefined,
      diff: (row.diff as string | null) ?? undefined,
      sourceFactIds: row.source_fact_ids ? (JSON.parse(row.source_fact_ids as string) as string[]) : undefined,
      derivedExperienceIds: row.derived_experience_ids
        ? (JSON.parse(row.derived_experience_ids as string) as string[])
        : undefined,
    }));
  }

  async updateRevisionLinks(
    revisionId: string,
    links: { sourceFactIds?: string[]; derivedExperienceIds?: string[] },
  ): Promise<RevisionRecord | null> {
    const res = await this.db.execute({
      sql: 'SELECT * FROM revisions WHERE id = ?',
      args: [revisionId],
    });
    if (res.rows.length === 0) return null;
    const row = res.rows[0]!;
    const sourceFactIds = [
      ...new Set([
        ...((row.source_fact_ids ? JSON.parse(row.source_fact_ids as string) : []) as string[]),
        ...(links.sourceFactIds ?? []),
      ]),
    ];
    const derivedExperienceIds = [
      ...new Set([
        ...((row.derived_experience_ids
          ? JSON.parse(row.derived_experience_ids as string)
          : []) as string[]),
        ...(links.derivedExperienceIds ?? []),
      ]),
    ];
    await this.db.execute({
      sql: 'UPDATE revisions SET source_fact_ids = ?, derived_experience_ids = ? WHERE id = ?',
      args: [JSON.stringify(sourceFactIds), JSON.stringify(derivedExperienceIds), revisionId],
    });
    const updated = await this.db.execute({
      sql: 'SELECT * FROM revisions WHERE id = ?',
      args: [revisionId],
    });
    const updatedRow = updated.rows[0]!;
    return {
      id: updatedRow.id as string,
      artifactKey: updatedRow.artifact_key as string,
      version: Number(updatedRow.version),
      tool: updatedRow.tool as string,
      sessionId: (updatedRow.session_id as string | null) ?? undefined,
      ts: Number(updatedRow.ts),
      oldContent: (updatedRow.old_content as string | null) ?? undefined,
      newContent: (updatedRow.new_content as string | null) ?? undefined,
      diff: (updatedRow.diff as string | null) ?? undefined,
      sourceFactIds,
      derivedExperienceIds,
    };
  }

  // -------------------------------------------------------------------------
  // Journal (append-only, tombstone-capable)
  // -------------------------------------------------------------------------

  async append(event: Omit<JournalEvent, 'seq'>): Promise<void> {
    await this.db.execute({
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
    const res = await this.db.execute({ sql: 'SELECT * FROM journal ORDER BY seq', args: [] });
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
