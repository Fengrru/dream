/**
 * Core domain types for the Dream memory kernel.
 *
 * The kernel models memory the way cognitive science models it:
 * - a single unified memory space (no per-session stores; a session is an
 *   activation pattern, not a container),
 * - four kinds of long-term memory (episodic, semantic, procedural, self),
 * - a small working memory acting as the cognitive bus,
 * - a full memory lifecycle: encode -> consolidate ("dream") -> retrieve ->
 *   reconsolidate -> forget.
 */

export type MemoryKind = 'episodic' | 'semantic' | 'procedural' | 'self';

export type MemoryScope = 'user' | 'agent';

export type ProvenanceSource = 'user' | 'tool' | 'inference' | 'dream';

/** Who may overwrite a memory during reconsolidation, strongest first. */
export type EvidencePriority = 'user' | 'evidence' | 'inference';

export interface Provenance {
  source: ProvenanceSource;
  /** Session metadata only — never used as an isolation key. */
  sessionId?: string;
  /** Trust in 0..1. Dream-derived and inference-derived knowledge carries < 1. */
  trust: number;
}

export interface Association {
  to: string;
  type: 'temporal' | 'spatial' | 'entity' | 'causal' | 'similar';
  /** Conduction coefficient for spreading activation, 0..1. */
  weight: number;
}

/** Learned strategy for a recurring task (procedural memory payload). */
export interface StrategyGraph {
  /** Ordered steps replayed by the executive without LLM involvement. */
  steps: Array<{ tool: string; args: unknown }>;
}

/**
 * A mined parameter slot for a procedural skill. 'slot' bindings extract a
 * fresh value from the request text between two anchor tokens; 'literal'
 * bindings replay the frozen value but require it to appear in the request
 * (conservative: a string argument that never appears in the request is
 * treated as a mismatch, not silently replayed).
 */
export interface SkillBinding {
  stepIndex: number;
  key: string;
  mode: 'slot' | 'literal';
  /** Anchor token before the value (slot mode). */
  before?: string;
  /** Anchor token after the value (slot mode). */
  after?: string;
  /** The frozen training value. */
  example: string;
}

export interface MemoryNode {
  id: string;
  kind: MemoryKind;
  scope: MemoryScope;
  content: string;
  embedding: number[];
  edges: Association[];
  provenance: Provenance;
  /** Salience at encoding time, 0..1, set by the encoding gate. */
  importance: number;
  /** Retrievability, 0..1. Forgetting decays this instead of deleting. */
  strength: number;
  createdAt: number;
  lastAccessedAt: number;
  /** Reconsolidation window: until this instant the node may be rewritten. */
  labileUntil?: number;
  /** Set when the node has been processed by a dream (consolidation) cycle. */
  consolidatedAt?: number;
  version: number;
  /** True when the payload was flagged as a suspected prompt-injection attempt. */
  quarantined?: boolean;
  meta?: Record<string, unknown>;
}

export type ChunkKind = 'percept' | 'recalled' | 'conclusion' | 'tool_result' | 'intention';

export type ChunkSource = 'user' | 'tool' | 'agent';

/** A unit of attention flowing through the working-memory bus. */
export interface ChunkCandidate {
  content: string;
  kind: ChunkKind;
  source: ChunkSource;
  /** User-stated stable fact -> encoded as semantic memory. */
  explicitFact?: boolean;
  /** Evidence priority carried by corrections and conclusions. */
  priority?: EvidencePriority;
  /** Task classification used for procedural skill matching. */
  taskType?: string;
  meta?: Record<string, unknown>;
}

/** A chunk currently held in working memory. */
export interface WMChunk {
  id: string;
  candidate: ChunkCandidate;
  activation: number;
  lastRefreshedAt: number;
  attendedAt: number;
}

export interface WMSnapshot {
  at: number;
  items: Array<{ kind: ChunkKind; content: string; activation: number; source: ChunkSource }>;
}

/** A recorded task execution, the raw material of procedural memory. */
export interface TraceStep {
  tool: string;
  args: unknown;
}

export interface TaskTrace {
  id: string;
  taskType: string;
  steps: TraceStep[];
  outcome: 'success' | 'failure';
  ts: number;
  sessionId?: string;
  /** The user text that triggered the task — the raw material for slot mining. */
  percept?: string;
}

export type JournalEventType =
  | 'encode'
  | 'update'
  | 'recall'
  | 'decay'
  | 'abstract'
  | 'skill'
  | 'self'
  | 'purge'
  | 'policy'
  | 'wm';

/**
 * Append-only audit event. Journals store deltas and content hashes, never
 * content bodies, so purged memories leave a tombstone but no data.
 */
export interface JournalEvent {
  seq: number;
  ts: number;
  type: JournalEventType;
  nodeId?: string;
  version?: number;
  contentHash?: string;
  meta?: Record<string, unknown>;
}

export interface MemoryNodeFilter {
  kinds?: MemoryKind[];
  scope?: MemoryScope;
  minStrength?: number;
  excludeQuarantined?: boolean;
}

export interface ScoredNode {
  node: MemoryNode;
  similarity: number;
}

/** Persistence port for the unified memory space. */
export interface MemoryStore {
  putNode(node: MemoryNode): Promise<void>;
  getNode(id: string): Promise<MemoryNode | null>;
  deleteNode(id: string): Promise<boolean>;
  listNodes(filter?: MemoryNodeFilter): Promise<MemoryNode[]>;
  addEdge(fromId: string, edge: Association): Promise<void>;
  getEdges(fromId: string, type?: Association['type']): Promise<Association[]>;
  searchByEmbedding(query: number[], k: number, filter?: MemoryNodeFilter): Promise<ScoredNode[]>;
}

/** Append-only audit log port. */
export interface Journal {
  append(event: Omit<JournalEvent, 'seq'>): Promise<void>;
  list(): Promise<JournalEvent[]>;
}

/** Task-trace port feeding procedural memory induction. */
export interface TraceStore {
  appendTrace(trace: TaskTrace): Promise<void>;
  listTraces(taskType?: string): Promise<TaskTrace[]>;
}

export type PolicyDecision = 'allow' | 'deny' | 'ask';

export type MemoryOpType =
  | 'encode'
  | 'recall'
  | 'update'
  | 'forget'
  | 'purge'
  | 'self-read'
  | 'tool-execute';

export interface MemoryOp {
  type: MemoryOpType;
  pluginId?: string;
  nodeId?: string;
  scope?: MemoryScope;
  meta?: Record<string, unknown>;
}

/** Consolidation outcome, surfaced to the user as the "dream report". */
export interface DreamReport {
  startedAt: number;
  finishedAt: number;
  replayedEpisodes: number;
  abstractions: string[];
  mergedCount: number;
  skillsFormed: string[];
  skillsUpdated: string[];
  selfUpdates: string[];
  fadedCount: number;
  notes: string[];
}
