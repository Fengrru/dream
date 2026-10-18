import type {
  Association,
  Journal,
  JournalEvent,
  JournalEventType,
  MemoryNode,
  MemoryNodeFilter,
  MemoryStore,
  RevisionInput,
  RevisionRecord,
  RevisionStore,
  ScoredNode,
  TaskTrace,
  TraceStore,
} from './types';
import { cosineSimilarity } from './embeddings';

function matches(node: MemoryNode, filter?: MemoryNodeFilter): boolean {
  if (filter?.kinds && !filter.kinds.includes(node.kind)) return false;
  if (filter?.scope && node.scope !== filter.scope) return false;
  if (filter?.userId !== undefined && (node.userId ?? 'default') !== filter.userId) return false;
  if (filter?.createdAfter !== undefined && node.createdAt < filter.createdAfter) return false;
  if (filter?.asOf !== undefined) {
    const from = node.validFrom ?? Number.NEGATIVE_INFINITY;
    const until = node.validUntil ?? Number.POSITIVE_INFINITY;
    if (filter.asOf < from || filter.asOf > until) return false;
  }
  if (filter?.minStrength !== undefined && node.strength < filter.minStrength) return false;
  if (filter?.excludeQuarantined && node.quarantined) return false;
  // Current recall only sees the latest version of a fact; history walks the
  // chain explicitly with includeSuperseded.
  if (!filter?.includeSuperseded && node.isLatest === false) return false;
  return true;
}

/**
 * Copy-on-read node clone. Embedding arrays are SHARED by convention:
 * embeddings are treated as immutable — lifecycle code replaces
 * `node.embedding` wholesale instead of mutating entries in place. This keeps
 * the hot read paths (getNode/searchByEmbedding during activation) from
 * cloning hundreds of floats on every call.
 */
function cloneNode(node: MemoryNode): MemoryNode {
  return {
    ...node,
    embedding: node.embedding,
    edges: node.edges.map((e) => ({ ...e })),
    provenance: { ...node.provenance },
    meta: node.meta ? { ...node.meta } : undefined,
  };
}

/** In-memory implementation of every storage port. Deterministic, for tests and evals. */
export class InMemoryStore implements MemoryStore, TraceStore, Journal, RevisionStore {
  private readonly nodes = new Map<string, MemoryNode>();
  private readonly traces: TaskTrace[] = [];
  private readonly revisions = new Map<string, RevisionRecord[]>();
  private events: JournalEvent[] = [];
  private seq = 0;
  private revisionSeq = 0;

  async putNode(node: MemoryNode): Promise<void> {
    this.nodes.set(node.id, cloneNode(node));
  }

  async getNode(id: string): Promise<MemoryNode | null> {
    const node = this.nodes.get(id);
    return node ? cloneNode(node) : null;
  }

  async deleteNode(id: string): Promise<boolean> {
    return this.nodes.delete(id);
  }

  async listNodes(filter?: MemoryNodeFilter): Promise<MemoryNode[]> {
    const out: MemoryNode[] = [];
    for (const node of this.nodes.values()) {
      if (matches(node, filter)) out.push(cloneNode(node));
    }
    return out;
  }

  async listNodesForScoring(filter?: MemoryNodeFilter): Promise<MemoryNode[]> {
    const out: MemoryNode[] = [];
    for (const node of this.nodes.values()) {
      if (!matches(node, filter)) continue;
      out.push({
        ...node,
        edges: [],
        embedding: node.embedding,
        provenance: { ...node.provenance },
        meta: node.meta ? { ...node.meta } : undefined,
      });
    }
    return out;
  }

  async addEdge(fromId: string, edge: Association): Promise<void> {
    const node = this.nodes.get(fromId);
    if (!node) return;
    if (node.edges.some((e) => e.to === edge.to && e.type === edge.type)) return;
    node.edges.push({ ...edge });
  }

  async getEdges(fromId: string, type?: Association['type']): Promise<Association[]> {
    const node = this.nodes.get(fromId);
    if (!node) return [];
    return node.edges.filter((e) => !type || e.type === type).map((e) => ({ ...e }));
  }

  async searchByEmbedding(
    query: number[],
    k: number,
    filter?: MemoryNodeFilter,
  ): Promise<ScoredNode[]> {
    // Score first, clone only the top-k — activation calls this constantly.
    const candidates: Array<{ node: MemoryNode; similarity: number }> = [];
    for (const node of this.nodes.values()) {
      if (!matches(node, filter)) continue;
      candidates.push({ node, similarity: cosineSimilarity(query, node.embedding) });
    }
    candidates.sort((a, b) => b.similarity - a.similarity);
    return candidates.slice(0, k).map((s) => ({
      node: cloneNode(s.node),
      similarity: s.similarity,
    }));
  }

  async appendTrace(trace: TaskTrace): Promise<void> {
    this.traces.push(structuredClone(trace));
  }

  async listTraces(taskType?: string): Promise<TaskTrace[]> {
    return this.traces
      .filter((t) => !taskType || t.taskType === taskType)
      .map((t) => structuredClone(t));
  }

  async appendRevision(input: RevisionInput): Promise<RevisionRecord> {
    const chain = this.revisions.get(input.artifactKey) ?? [];
    const record: RevisionRecord = {
      ...structuredClone(input),
      id: `rev_${++this.revisionSeq}`,
      version: chain.length + 1,
    };
    chain.push(record);
    this.revisions.set(input.artifactKey, chain);
    return structuredClone(record);
  }

  async listRevisions(artifactKey: string): Promise<RevisionRecord[]> {
    return (this.revisions.get(artifactKey) ?? []).map((record) => structuredClone(record));
  }

  async updateRevisionLinks(
    revisionId: string,
    links: { sourceFactIds?: string[]; derivedExperienceIds?: string[] },
  ): Promise<RevisionRecord | null> {
    for (const chain of this.revisions.values()) {
      const index = chain.findIndex((record) => record.id === revisionId);
      if (index < 0) continue;
      const record = chain[index]!;
      record.sourceFactIds = [
        ...new Set([...(record.sourceFactIds ?? []), ...(links.sourceFactIds ?? [])]),
      ];
      record.derivedExperienceIds = [
        ...new Set([...(record.derivedExperienceIds ?? []), ...(links.derivedExperienceIds ?? [])]),
      ];
      return structuredClone(record);
    }
    return null;
  }

  async append(event: Omit<JournalEvent, 'seq'>): Promise<void> {
    this.events.push({ ...event, seq: ++this.seq });
  }

  async list(): Promise<JournalEvent[]> {
    return [...this.events];
  }

  async eventsOfType(type: JournalEventType): Promise<JournalEvent[]> {
    return this.events.filter((e) => e.type === type);
  }
}
