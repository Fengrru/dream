import type {
  Association,
  Journal,
  JournalEvent,
  JournalEventType,
  MemoryNode,
  MemoryNodeFilter,
  MemoryStore,
  ScoredNode,
  TaskTrace,
  TraceStore,
} from './types';
import { cosineSimilarity } from './embeddings';

function matches(node: MemoryNode, filter?: MemoryNodeFilter): boolean {
  if (filter?.kinds && !filter.kinds.includes(node.kind)) return false;
  if (filter?.scope && node.scope !== filter.scope) return false;
  if (filter?.minStrength !== undefined && node.strength < filter.minStrength) return false;
  if (filter?.excludeQuarantined && node.quarantined) return false;
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
export class InMemoryStore implements MemoryStore, TraceStore, Journal {
  private readonly nodes = new Map<string, MemoryNode>();
  private readonly traces: TaskTrace[] = [];
  private events: JournalEvent[] = [];
  private seq = 0;

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
