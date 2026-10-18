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
  type:
    | 'temporal'
    | 'spatial'
    | 'entity'
    | 'causal'
    | 'contrast'
    | 'elaborates'
    | 'similar'
    | 'version';
  /** Conduction coefficient for spreading activation, 0..1. */
  weight: number;
}

/** One hop of a typed relation path used to explain activation. */
export interface RelationStep {
  from: string;
  to: string;
  type: Association['type'];
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
  /** Owner partition. Undefined is treated as 'default' for legacy records. */
  userId?: string;
  /** Discussion episode (time-gap segmentation); cross-session grouping. */
  episodeId?: string;
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
  /** When the fact happened (event time), distinct from system write time. */
  eventTime?: number;
  /** Validity interval for as-of recall. Undefined bounds are open. */
  validFrom?: number;
  validUntil?: number;
  /** How many independent observations support this record. */
  evidenceCount?: number;
  /** Calibrated confidence, 0..1 (defaults to 1 for records without one). */
  confidence?: number;
  /** Reconsolidation window: until this instant the node may be rewritten. */
  labileUntil?: number;
  /** Set when the node has been processed by a dream (consolidation) cycle. */
  consolidatedAt?: number;
  version: number;
  /**
   * Version chain: ids of older records this node replaces. Facts are never
   * destructively overwritten once the reconsolidation window has closed; a
   * correction creates a new latest version and links it to its predecessors.
   */
  supersedes?: string[];
  /** Id of the newer version that replaced this record. Present => historical. */
  supersededBy?: string;
  /** Current version flag. Undefined is treated as true for legacy records. */
  isLatest?: boolean;
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
  /** Verbatim, addressable source text kept alongside a summary (never embedded). */
  details?: string;
  /** Task scene tag used for per-scene retrieval boosting (chat/working/coding). */
  scene?: string;
  /** Absolute expiry for prospective intentions (nodes demote to facts afterwards). */
  expiresAt?: number;
  /** Event time / validity interval for temporal recall. */
  eventTime?: number;
  validFrom?: number;
  validUntil?: number;
  /** Evidence count and calibrated confidence (defaults: 1 and 1). */
  evidenceCount?: number;
  confidence?: number;
  /** Explicit entity tags; deterministic surface entities are added at encode. */
  tags?: string[];
  /** Explicit episode; omitted -> time-gap segmentation at encode. */
  episodeId?: string;
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
  /** Execution environment (repo, account, cluster, staging/prod) the trace ran in. */
  environment?: string;
  /** Facts this trace produced or updated (TriLink fact layer). */
  factIds?: string[];
}

export type JournalEventType =
  | 'encode'
  | 'update'
  | 'recall'
  | 'decay'
  | 'abstract'
  | 'skill'
  | 'self'
  | 'revision'
  | 'trace'
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
  /** Restrict to one owner partition ('default' for legacy records). */
  userId?: string;
  /** Only records whose validity interval contains this instant. */
  asOf?: number;
  /** Only records written at/after this system time. */
  createdAfter?: number;
  /** Restrict to one discussion episode. */
  episodeId?: string;
  minStrength?: number;
  excludeQuarantined?: boolean;
  /** Include superseded versions (history/audit). Default: current versions only. */
  includeSuperseded?: boolean;
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
  /**
   * Optional lightweight listing for scoring passes that only need content,
   * embedding and strength. Implementations may skip loading association
   * edges, which dominates the cost of a dense graph.
   */
  listNodesForScoring?(filter?: MemoryNodeFilter): Promise<MemoryNode[]>;
  addEdge(fromId: string, edge: Association): Promise<void>;
  getEdges(fromId: string, type?: Association['type']): Promise<Association[]>;
  searchByEmbedding(query: number[], k: number, filter?: MemoryNodeFilter): Promise<ScoredNode[]>;
}

/** Append-only audit log port. */
export interface Journal {
  append(event: Omit<JournalEvent, 'seq'>): Promise<void>;
  list(): Promise<JournalEvent[]>;
}

/**
 * A deterministic record of one artifact edit. Revisions are not memory nodes:
 * they are the exact history a summary intentionally drops (Hy-Memory's
 * version-evolution chain, generalized beyond coding).
 */
export interface RevisionInput {
  artifactKey: string;
  tool: string;
  sessionId?: string;
  ts: number;
  oldContent?: string;
  newContent?: string;
  diff?: string;
  /** TriLink: facts and experiences this change belongs to. */
  sourceFactIds?: string[];
  derivedExperienceIds?: string[];
}

export interface RevisionRecord extends RevisionInput {
  id: string;
  /** Monotonic per artifactKey, starting at 1. */
  version: number;
}

/** Optional query expansion hook applied before activation. */
export interface QueryRewriter {
  id: string;
  rewrite(query: string): string | Promise<string>;
}

/** Append-only revision chain port. */
export interface RevisionStore {
  appendRevision(input: RevisionInput): Promise<RevisionRecord>;
  listRevisions(artifactKey: string): Promise<RevisionRecord[]>;
  /** Attach TriLink provenance to an existing revision (optional capability). */
  updateRevisionLinks?(
    revisionId: string,
    links: { sourceFactIds?: string[]; derivedExperienceIds?: string[] },
  ): Promise<RevisionRecord | null>;
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
  traceId?: string;
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
