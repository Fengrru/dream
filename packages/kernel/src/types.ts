import type {
  ChunkCandidate,
  DreamReport,
  EvidencePriority,
  MemoryKind,
  MemoryScope,
  PolicyDecision,
  TraceStep,
  WMSnapshot,
} from '@dream/core';
import type { DreamContext } from './kernel';

/** Memory capabilities a plugin must explicitly declare (deny-by-default). */
export interface MemoryCapabilities {
  encode?: boolean;
  recall?: boolean;
  update?: boolean;
  forget?: boolean;
  purge?: boolean;
  selfRead?: boolean;
}

export interface DreamPlugin {
  name: string;
  version?: string;
  /** Names of plugins this one depends on. */
  requires?: string[];
  /** Declared memory operations. Undeclared ops are hard-denied. */
  memory?: MemoryCapabilities;
  apply(ctx: DreamContext): void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface RegisteredTool extends ToolSpec {
  handler(args: unknown, callCtx: { sessionId?: string }): unknown | Promise<unknown>;
}

export interface ToolCallCtx {
  name: string;
  args: unknown;
  pluginId: string;
  sessionId?: string;
}

export interface ToolResultCtx extends ToolCallCtx {
  result: unknown;
}

export interface ToolExecutionResult {
  ok: boolean;
  result?: unknown;
  error?: string;
  deniedBy?: string;
}

// ---------------------------------------------------------------------------
// Reasoning
// ---------------------------------------------------------------------------

export interface RecalledNode {
  id: string;
  content: string;
  kind: MemoryKind;
  scope: MemoryScope;
  primed: boolean;
  similarity?: number;
}

export interface ReasoningRequest {
  userText: string;
  sessionId: string;
  wm: WMSnapshot;
  tools: ToolSpec[];
  /** Memories activated for this turn (already post-read-scrubbed). */
  recalledNodes: RecalledNode[];
  /** Current self-model summary for persona continuity. */
  selfSummary: string;
}

export type Thought =
  | { kind: 'final'; content: string }
  | { kind: 'tool_calls'; calls: Array<{ name: string; args: unknown }> }
  | { kind: 'recall'; query: string }
  | {
      kind: 'correct';
      nodeId: string;
      content: string;
      priority: EvidencePriority;
      reason?: string;
    };

export interface ReasoningStrategy {
  id: string;
  think(req: ReasoningRequest): Promise<Thought>;
}

// ---------------------------------------------------------------------------
// Memory operations (what the facade exposes to capability-checked plugins)
// ---------------------------------------------------------------------------

export interface EncodeRequest {
  candidate: ChunkCandidate;
}

export interface RecallResult {
  nodes: RecalledNode[];
  primed: RecalledNode[];
}

export interface UpdateRequest {
  nodeId: string;
  content: string;
  priority: EvidencePriority;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Consolidation extension surface
// ---------------------------------------------------------------------------

export interface DreamPass {
  name: string;
  run(report: DreamReport): Promise<void>;
}

// ---------------------------------------------------------------------------
// Shared hook plumbing
// ---------------------------------------------------------------------------

export type { PolicyDecision, TraceStep, WMSnapshot, ChunkCandidate };
