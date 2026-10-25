import {
  ActivationEngine,
  EncodingGate,
  LifecycleEngine,
  SelfModelManager,
  WorkingMemory,
  PolicyViolationError,
  newId,
  sha256Hex,
  type DreamReport,
  type EmbeddingProvider,
  type Journal,
  type MemoryNode,
  type MemoryOp,
  type MemoryStore,
  type TraceStore,
} from '@dream/core';
import {
  InjectionHeuristics,
  MemoryPolicyEngine,
  SecretScrubber,
  type ApprovalService,
} from '@dream/policies';
import { dreamConfigSchema, type ResolvedDreamConfig } from './config';
import { SilentLogger, type Logger } from './logger';
import { SessionRunner } from './session';
import type {
  DreamPass,
  DreamPlugin,
  MemoryCapabilities,
  ReasoningStrategy,
  RecalledNode,
  RegisteredTool,
  ToolCallCtx,
  ToolExecutionResult,
  ToolResultCtx,
  ToolSpec,
} from './types';

export interface DreamComponents {
  memory: MemoryStore;
  journal: Journal;
  traces: TraceStore;
  provider: EmbeddingProvider;
  config?: Record<string, unknown>;
  approval?: ApprovalService;
  logger?: Logger;
  clock?: () => number;
}

type BusHandler = (payload: unknown) => void;

interface ToolHook {
  pluginId: string;
  hook: (ctx: ToolCallCtx) => 'allow' | 'deny' | 'ask' | Promise<'allow' | 'deny' | 'ask'>;
}

interface ToolPostHook {
  pluginId: string;
  hook: (ctx: ToolResultCtx) => unknown;
}

interface MemoryWriteHook {
  pluginId: string;
  hook: (candidate: { content: string; meta?: Record<string, unknown> }) => void;
}

interface MemoryReadHook {
  pluginId: string;
  hook: (node: RecalledNode) => void;
}

/**
 * The Dream kernel.
 *
 * Everything is a plugin — except memory. The kernel owns the privileged core
 * (working memory, unified memory space, lifecycle engine, self-model) and
 * provides exactly five extension surfaces to plugins: bus events, tools,
 * cognition strategies, dream passes, and the memory facade. Every tool call
 * passes through a single waterfall (no second door); every memory operation
 * is policy-checked, journaled, and capability-scoped per plugin.
 */
export class DreamKernel {
  readonly store: MemoryStore;
  readonly journal: Journal;
  readonly traces: TraceStore;
  readonly provider: EmbeddingProvider;
  readonly config: ResolvedDreamConfig;
  readonly wm: WorkingMemory;
  readonly policy: MemoryPolicyEngine;
  readonly gate: EncodingGate;
  readonly lifecycle: LifecycleEngine;
  readonly self: SelfModelManager;
  readonly logger: Logger;
  readonly clock: () => number;
  readonly approval?: ApprovalService;

  private readonly plugins = new Map<string, DreamPlugin>();
  private readonly capabilities = new Map<string, MemoryCapabilities>();
  private readonly toolRegistry = new Map<string, RegisteredTool>();
  private readonly strategies = new Map<string, ReasoningStrategy>();
  private readonly preToolHooks: ToolHook[] = [];
  private readonly postToolHooks: ToolPostHook[] = [];
  private readonly preWriteHooks: MemoryWriteHook[] = [];
  private readonly postReadHooks: MemoryReadHook[] = [];
  private readonly passes: Array<{ pluginId: string; pass: DreamPass }> = [];
  private readonly bus = new Map<string, Set<BusHandler>>();
  private readonly injection = new InjectionHeuristics();
  private readonly scrubber: SecretScrubber | null;
  private lastReport: DreamReport | null = null;
  private dreamInFlight: Promise<DreamReport> | null = null;

  constructor(components: DreamComponents, configInput?: Record<string, unknown>) {
    this.store = components.memory;
    this.journal = components.journal;
    this.traces = components.traces;
    this.provider = components.provider;
    this.clock = components.clock ?? Date.now;
    this.config = dreamConfigSchema.parse(configInput ?? components.config ?? {});
    this.logger = components.logger ?? new SilentLogger();
    this.approval = components.approval;
    this.policy = new MemoryPolicyEngine(this.config.preset, components.approval);
    this.scrubber = this.config.scrubSecrets ? new SecretScrubber() : null;

    this.wm = new WorkingMemory(this.config.wmCapacity, this.clock);
    this.gate = new EncodingGate(this.store, this.journal, this.provider, undefined, this.clock);
    this.lifecycle = new LifecycleEngine(
      this.store,
      this.traces,
      this.journal,
      this.provider,
      {
        reconsolidationWindowMs: this.config.reconsolidationWindowMs,
        decayTauBaseMs: this.config.decayTauBaseMs,
        forgetFloor: 0.05,
        mergeThreshold: this.config.mergeThreshold,
        abstractionMinCluster: this.config.abstractionMinCluster,
        abstractionLinkThreshold: 0.55,
        skillMinSuccessfulEpisodes: this.config.skillMinSuccessfulEpisodes,
        skillMinSuccessRate: this.config.skillMinSuccessRate,
        replayStrengthens: this.config.replayStrengthens,
        replayStrengthensThreshold: this.config.replayStrengthensThreshold,
        maxTraces: this.config.maxTraces,
      },
      this.clock,
    );
    this.self = new SelfModelManager(this.store, this.provider, this.journal, this.clock);

    // Built-in pre-write defense: scrub secrets before anything is encoded.
    this.preWriteHooks.push({
      pluginId: 'kernel',
      hook: (candidate) => {
        if (!this.scrubber) return;
        const { redacted, findings } = this.scrubber.scrub(candidate.content);
        if (findings.length > 0) {
          candidate.content = redacted;
          candidate.meta = { ...(candidate.meta ?? {}), scrubbed: findings.map((f) => f.kind) };
          this.logger.warn('secrets scrubbed before encoding', { kinds: findings.map((f) => f.kind) });
        }
      },
    });
    // Built-in post-read defense: never let a secret reach a model from recall.
    this.postReadHooks.push({
      pluginId: 'kernel',
      hook: (node) => {
        if (!this.scrubber) return;
        const { redacted, findings } = this.scrubber.scrub(node.content);
        if (findings.length > 0) node.content = redacted;
      },
    });
  }

  // -------------------------------------------------------------------------
  // Plugin host
  // -------------------------------------------------------------------------

  async use(plugin: DreamPlugin): Promise<this> {
    if (this.plugins.has(plugin.name)) {
      throw new Error(`plugin "${plugin.name}" is already registered`);
    }
    for (const dep of plugin.requires ?? []) {
      if (!this.plugins.has(dep)) {
        throw new Error(`plugin "${plugin.name}" requires "${dep}", which is not registered`);
      }
    }
    this.plugins.set(plugin.name, plugin);
    this.capabilities.set(plugin.name, plugin.memory ?? {});
    this.logger.info('plugin registered', { plugin: plugin.name, memory: plugin.memory ?? {} });
    try {
      await plugin.apply(this.contextFor(plugin.name));
    } catch (err) {
      // Roll back the registration so a failed apply doesn't leave a name
      // that blocks retries ("already registered") while advertising nothing.
      this.plugins.delete(plugin.name);
      this.capabilities.delete(plugin.name);
      throw err;
    }
    return this;
  }

  hasPlugin(name: string): boolean {
    return this.plugins.has(name);
  }

  private contextFor(pluginId: string): DreamContext {
    return new DreamContext(this, pluginId);
  }

  // -------------------------------------------------------------------------
  // Bus
  // -------------------------------------------------------------------------

  on(event: string, handler: BusHandler): () => void {
    const set = this.bus.get(event) ?? new Set<BusHandler>();
    set.add(handler);
    this.bus.set(event, set);
    return () => set.delete(handler);
  }

  emit(event: string, payload: unknown): void {
    for (const handler of this.bus.get(event) ?? []) {
      try {
        handler(payload);
      } catch (err) {
        this.logger.error('bus handler failed', { event, error: String(err) });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Memory operations (root — capability checks apply to plugin facades only)
  // -------------------------------------------------------------------------

  async encodeChunk(
    candidate: import('@dream/core').ChunkCandidate,
    opts: { pluginId: string; sessionId?: string } = { pluginId: 'kernel' },
  ): Promise<MemoryNode | null> {
    const mutable = {
      content: candidate.content,
      meta: candidate.meta as Record<string, unknown> | undefined,
    };
    for (const { hook } of this.preWriteHooks) hook(mutable);

    const scan = this.injection.scan(mutable.content);
    if (scan.score >= this.config.injectionThreshold) {
      mutable.meta = {
        ...(mutable.meta ?? {}),
        quarantined: true,
        injectionMarkers: scan.matched,
      };
      this.logger.warn('content quarantined: suspected prompt injection', {
        markers: scan.matched,
      });
    }

    const decision = await this.decide({ type: 'encode', pluginId: opts.pluginId });
    if (decision !== 'allow') {
      return null;
    }

    const node = await this.gate.encode(
      {
        ...candidate,
        content: mutable.content,
        meta: mutable.meta,
      },
      { sessionId: opts.sessionId },
    );
    if (node) {
      // Quarantined payloads are never broadcast on the bus — subscribers
      // get the id and the quarantine flag, not the poisoned content.
      this.emit('memory/encode', {
        nodeId: node.id,
        kind: node.kind,
        pluginId: opts.pluginId,
        sessionId: opts.sessionId,
        content: node.quarantined ? undefined : node.content,
        quarantined: node.quarantined === true,
      });
    }
    return node;
  }

  /**
   * Context recall: spreading activation over the unified space. Marks access
   * (retrieval practice opens the reconsolidation window) unless primingOnly.
   */
  async recallContext(
    query: string,
    opts: {
      pluginId: string;
      sessionId?: string;
      primingOnly?: boolean;
      capacity?: number;
    } = { pluginId: 'kernel' },
  ): Promise<{ nodes: RecalledNode[]; primed: RecalledNode[]; workingCandidates: import('@dream/core').ChunkCandidate[] }> {
    const decision = await this.decide({ type: 'recall', pluginId: opts.pluginId });
    if (decision !== 'allow') return { nodes: [], primed: [], workingCandidates: [] };

    const engine = new ActivationEngine(this.provider);
    const set = await engine.activate(this.store, [query], {
      capacity: opts.capacity ?? this.config.wmCapacity,
      excludeSessionId: opts.sessionId,
      now: this.clock,
    });

    const toNode = async (candidate: import('@dream/core').ChunkCandidate, primed: boolean): Promise<RecalledNode> => ({
      id: candidate.meta?.['nodeId'] as string,
      content: candidate.content,
      kind: candidate.meta?.['nodeKind'] as RecalledNode['kind'],
      scope: candidate.meta?.['scope'] as RecalledNode['scope'],
      primed,
    });

    const nodes: RecalledNode[] = [];
    for (const c of set.workingSet) nodes.push(await toNode(c, false));
    const primed: RecalledNode[] = [];
    for (const c of set.primed) primed.push(await toNode(c, true));

    for (const node of [...nodes, ...primed]) {
      for (const { hook } of this.postReadHooks) hook(node);
    }

    if (!opts.primingOnly && nodes.length > 0) {
      await this.lifecycle.onRecalled(nodes.map((n) => n.id));
    }

    return {
      nodes,
      primed,
      workingCandidates: set.workingSet,
    };
  }

  async updateMemory(
    nodeId: string,
    content: string,
    priority: import('@dream/core').EvidencePriority,
    reason: string,
    pluginId = 'kernel',
  ): Promise<MemoryNode> {
    const decision = await this.decide({ type: 'update', nodeId, pluginId });
    if (decision !== 'allow') throw new PolicyViolationError('policy', 'update denied by policy');
    return this.lifecycle.applyUpdate(nodeId, { content, priority, reason: this.scrubContent(reason) });
  }

  async forgetMemory(nodeId: string, reason: string, pluginId = 'kernel'): Promise<boolean> {
    const decision = await this.decide({ type: 'forget', nodeId, pluginId });
    if (decision !== 'allow') return false;
    return this.lifecycle.softForget(nodeId, this.scrubContent(reason));
  }

  /** Approved hard purge — the only path that deletes content. */
  async purgeMemory(nodeId: string, reason: string, pluginId = 'kernel'): Promise<boolean> {
    const decision = await this.decide({ type: 'purge', nodeId, pluginId });
    if (decision !== 'allow') return false;
    return this.lifecycle.hardForget(nodeId, this.scrubContent(reason));
  }

  /** Read path for UI surfaces: policy-checked, quarantined excluded, scrubbed. */
  async listMemories(limit = 30): Promise<Array<{
    id: string;
    kind: string;
    content: string;
    strength: number;
    importance: number;
    createdAt: number;
    lastAccessedAt: number;
  }>> {
    const decision = await this.decide({ type: 'recall', pluginId: 'gateway' });
    if (decision !== 'allow') return [];
    const nodes = await this.store.listNodes({ excludeQuarantined: true });
    return [...nodes]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map((n) => ({
        id: n.id,
        kind: n.kind,
        content: this.scrubContent(n.content),
        strength: Math.round(n.strength * 100) / 100,
        importance: Math.round(n.importance * 100) / 100,
        createdAt: n.createdAt,
        lastAccessedAt: n.lastAccessedAt,
      }));
  }

  /** Faded memories still above hard deletion — recoverable via a strong cue. */
  async forgettingBin(limit = 30): Promise<Array<{
    id: string;
    kind: string;
    content: string;
    strength: number;
    lastAccessedAt: number;
  }>> {
    const decision = await this.decide({ type: 'recall', pluginId: 'gateway' });
    if (decision !== 'allow') return [];
    const nodes = await this.store.listNodes({ excludeQuarantined: true });
    return nodes
      .filter((n) => n.strength < 0.15 && n.kind !== 'procedural')
      .sort((a, b) => a.strength - b.strength)
      .slice(0, limit)
      .map((n) => ({
        id: n.id,
        kind: n.kind,
        content: this.scrubContent(n.content),
        strength: Math.round(n.strength * 1000) / 1000,
        lastAccessedAt: n.lastAccessedAt,
      }));
  }

  /** Strong-cue revival: retrieval practice without exposing raw/quarantined content. */
  async reviveMemory(nodeId: string): Promise<{ ok: boolean; content?: string }> {
    const decision = await this.decide({ type: 'recall', nodeId, pluginId: 'gateway' });
    if (decision !== 'allow') return { ok: false };
    const node = await this.store.getNode(nodeId);
    if (!node || node.quarantined) return { ok: false };
    const revived = await this.lifecycle.onRecalled([nodeId]);
    return { ok: revived > 0, content: this.scrubContent(node.content) };
  }

  /** Human-approved release of quarantined content back into recall. */
  async releaseQuarantined(nodeId: string, reason: string): Promise<MemoryNode | null> {
    // Releasing poisoned content is a deliberate human action: require an
    // approval service even in presets where ordinary updates are allowed.
    if (!this.approval) return null;
    const decision = await this.decide({ type: 'update', nodeId, pluginId: 'kernel' });
    if (decision !== 'allow') return null;
    const granted =
      (await this.approval.request({
        type: 'update',
        nodeId,
        pluginId: 'kernel',
        meta: { action: 'release-quarantine' },
      })) === 'allow';
    if (!granted) return null;
    return this.lifecycle.releaseQuarantine(nodeId, this.scrubContent(reason));
  }

  private scrubContent(content: string): string {
    return this.scrubber ? this.scrubber.scrub(content).redacted : content;
  }

  private async decide(op: MemoryOp): Promise<'allow' | 'deny' | 'ask'> {
    const { decision } = await this.policy.decide(op);
    if (decision !== 'allow') {
      await this.journal.append({
        ts: this.clock(),
        type: 'policy',
        nodeId: op.nodeId,
        meta: { op: op.type, pluginId: op.pluginId, decision },
      });
    }
    return decision;
  }

  // -------------------------------------------------------------------------
  // Tool pipeline — the single waterfall, no second door
  // -------------------------------------------------------------------------

  async executeTool(
    call: { name: string; args: unknown },
    opts: { pluginId: string; sessionId?: string } = { pluginId: 'kernel' },
  ): Promise<ToolExecutionResult> {
    const tool = this.toolRegistry.get(call.name);
    const ctx: ToolCallCtx = { name: call.name, args: call.args, pluginId: opts.pluginId, sessionId: opts.sessionId };
    if (!tool) {
      return { ok: false, error: `unknown tool "${call.name}"` };
    }

    for (const { pluginId, hook } of this.preToolHooks) {
      let decision: 'allow' | 'deny' | 'ask';
      try {
        decision = await hook(ctx);
      } catch (err) {
        // A broken policy hook must fail closed, not abort the whole turn
        // with an unjournaled exception.
        this.logger.error('pre-execute hook failed; treating as deny', {
          pluginId,
          tool: call.name,
          error: String(err),
        });
        decision = 'deny';
      }
      if (decision === 'deny') {
        await this.journal.append({
          ts: this.clock(),
          type: 'policy',
          meta: { op: 'tool-execute', pluginId, tool: call.name, decision: 'deny' },
        });
        return { ok: false, deniedBy: pluginId, error: `tool "${call.name}" denied by policy plugin "${pluginId}"` };
      }
      if (decision === 'ask') {
        const granted = this.approval
          ? (await this.approval.request({ type: 'tool-execute', pluginId, meta: { tool: call.name } })) === 'allow'
          : false; // fail-closed: no approval service -> no
        if (!granted) {
          await this.journal.append({
            ts: this.clock(),
            type: 'policy',
            meta: { op: 'tool-execute', pluginId, tool: call.name, decision: 'deny-unapproved' },
          });
          return { ok: false, deniedBy: pluginId, error: `tool "${call.name}" not approved` };
        }
      }
    }

    // Side-effect tools are fail-closed: no approval service, no execution.
    // This covers skill replay too, because replay uses the same pipeline.
    if (tool.sideEffect === true && this.config.requireToolApproval) {
      const granted = this.approval
        ? (await this.approval.request({
            type: 'tool-execute',
            pluginId: opts.pluginId,
            meta: { tool: call.name, sideEffect: true },
          })) === 'allow'
        : false;
      if (!granted) {
        await this.journal.append({
          ts: this.clock(),
          type: 'policy',
          meta: { op: 'tool-execute', tool: call.name, decision: 'deny-side-effect' },
        });
        return {
          ok: false,
          error: `tool "${call.name}" has side effects and requires approval (none granted)`,
        };
      }
    }

    let result: unknown;
    try {
      result = await tool.handler(call.args, { sessionId: opts.sessionId });
    } catch (err) {
      // No args on the bus: tool arguments are caller-controlled payloads and
      // subscribers have no capability gate for them.
      this.emit('tool/execute', { name: call.name, pluginId: opts.pluginId, sessionId: opts.sessionId, ok: false, error: String(err) });
      return { ok: false, error: String(err) };
    }

    const resultCtx: ToolResultCtx = { ...ctx, result };
    for (const { pluginId, hook } of this.postToolHooks) {
      let replacement: unknown;
      try {
        replacement = hook(resultCtx);
      } catch (err) {
        // A broken rewrite hook must not discard the result of a tool that
        // already executed; pass the original result through.
        this.logger.error('post-execute hook failed; result passes through unmodified', {
          pluginId,
          tool: call.name,
          error: String(err),
        });
        continue;
      }
      if (replacement !== undefined) resultCtx.result = replacement;
    }

    this.emit('tool/execute', { name: call.name, pluginId: opts.pluginId, sessionId: opts.sessionId, ok: true });
    return { ok: true, result: resultCtx.result };
  }

  toolSpecs(): ToolSpec[] {
    return [...this.toolRegistry.values()].map(({ name, description, parameters, sideEffect }) => ({
      name,
      description,
      parameters,
      sideEffect: sideEffect === true,
    }));
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  session(sessionId?: string): SessionRunner {
    return new SessionRunner(this, sessionId);
  }

  // -------------------------------------------------------------------------
  // Consolidation
  // -------------------------------------------------------------------------

  async dreamNow(): Promise<DreamReport> {
    // Idle timer, manual /dream and session-close can all race; consolidate once.
    if (this.dreamInFlight) return this.dreamInFlight;
    this.dreamInFlight = this.runDream();
    try {
      return await this.dreamInFlight;
    } finally {
      this.dreamInFlight = null;
    }
  }

  private async runDream(): Promise<DreamReport> {
    const report = await this.lifecycle.dream();

    // Wire the self-model to learning: newly formed/refreshed skills become
    // expertise nodes, so the next session's prompt actually knows them.
    for (const taskType of report.skillsFormed) {
      try {
        await this.self.boostExpertise(taskType, 0.1);
        report.selfUpdates.push(`expertise:${taskType}`);
      } catch (err) {
        this.logger.error('self-model update failed', { taskType, error: String(err) });
      }
    }
    for (const taskType of report.skillsUpdated) {
      try {
        await this.self.boostExpertise(taskType, 0.03);
        report.selfUpdates.push(`expertise:${taskType}`);
      } catch (err) {
        this.logger.error('self-model update failed', { taskType, error: String(err) });
      }
    }

    for (const { pluginId, pass } of this.passes) {
      try {
        await pass.run(report);
      } catch (err) {
        this.logger.error('dream pass failed', { pluginId, pass: pass.name, error: String(err) });
      }
    }
    report.finishedAt = this.clock();
    this.lastReport = report;
    this.emit('dream/report', report);
    this.logger.info('dream cycle complete', {
      episodes: report.replayedEpisodes,
      abstractions: report.abstractions.length,
      skillsFormed: report.skillsFormed.length,
      selfUpdates: report.selfUpdates.length,
    });
    return report;
  }

  lastDreamReport(): DreamReport | null {
    return this.lastReport;
  }

  async stats(): Promise<{ kind: string; count: number }[]> {
    const nodes = await this.store.listNodes();
    const counts = new Map<string, number>();
    for (const node of nodes) counts.set(node.kind, (counts.get(node.kind) ?? 0) + 1);
    return [...counts.entries()].map(([kind, count]) => ({ kind, count }));
  }

  // Internals used by DreamContext -------------------------------------------------

  registerTool(pluginId: string, tool: RegisteredTool): void {
    if (this.toolRegistry.has(tool.name)) {
      throw new Error(`tool "${tool.name}" already registered (by another plugin?)`);
    }
    if (!/^[A-Za-z0-9_.:-]{1,96}$/.test(tool.name)) {
      throw new Error(`tool "${tool.name}" has an invalid name`);
    }
    // Tool metadata comes from plugins/servers and lands in the model prompt.
    // Treat it as untrusted: collapse whitespace, cap length, strip payloads.
    // The input schema is scanned too — its description/title/default fields
    // are just as model-visible as the tool description.
    const scan = this.injection.scan(tool.description);
    const schemaScan = this.injection.scan(JSON.stringify(tool.parameters ?? {}));
    const description =
      scan.score > 0
        ? `Tool ${tool.name} (description withheld: untrusted metadata)`
        : tool.description.replace(/\s+/g, ' ').slice(0, 600);
    this.toolRegistry.set(tool.name, {
      ...tool,
      description,
      parameters:
        schemaScan.score > 0
          ? (stripSchemaProse(tool.parameters) as Record<string, unknown>)
          : tool.parameters,
      sideEffect: tool.sideEffect === true,
    });
  }

  /** Remove a tool registration (rollback for partial plugin failures). */
  unregisterTool(name: string): void {
    this.toolRegistry.delete(name);
  }

  registerStrategy(pluginId: string, strategy: ReasoningStrategy): void {
    if (this.strategies.size > 0) {
      this.logger.warn('multiple reasoning strategies registered; the first registered stays the default', {
        default: this.strategies.keys().next().value,
        ignored: strategy.id,
        registeredBy: pluginId,
      });
    }
    this.strategies.set(strategy.id, strategy);
  }

  defaultStrategy(): ReasoningStrategy | undefined {
    return this.strategies.values().next().value;
  }

  addPreToolHook(pluginId: string, hook: ToolHook['hook']): void {
    this.preToolHooks.push({ pluginId, hook });
  }

  addPostToolHook(pluginId: string, hook: ToolPostHook['hook']): void {
    this.postToolHooks.push({ pluginId, hook });
  }

  addPreWriteHook(pluginId: string, hook: MemoryWriteHook['hook']): void {
    this.preWriteHooks.push({ pluginId, hook });
  }

  addPostReadHook(pluginId: string, hook: MemoryReadHook['hook']): void {
    this.postReadHooks.push({ pluginId, hook });
  }

  addDreamPass(pluginId: string, pass: DreamPass): void {
    this.passes.push({ pluginId, pass });
  }

  assertCapability(pluginId: string, cap: keyof MemoryCapabilities): void {
    const caps = this.capabilities.get(pluginId) ?? {};
    if (!caps[cap]) {
      throw new PolicyViolationError(pluginId, cap);
    }
  }

  traceId(): string {
    return newId('trace');
  }

  hash(content: string): string {
    return sha256Hex(content);
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
declare function ConsoleLoggerLikeDeclaration(): void;

/**
 * Reduce a JSON-schema to its structural skeleton (type/properties/items/
 * required/enum), dropping every free-text field (description, title,
 * default, examples…). Used when an input schema trips the injection
 * heuristics: the shape stays usable, the prose payload does not.
 */
function stripSchemaProse(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripSchemaProse);
  if (node !== null && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'type' || key === 'properties' || key === 'items' || key === 'required' || key === 'enum') {
        out[key] = stripSchemaProse(value);
      }
    }
    return out;
  }
  return node;
}

/**
 * The context handed to each plugin. All memory access goes through the
 * scoped facade, which enforces the plugin's declared capabilities
 * (deny-by-default) before touching the kernel.
 */
export class DreamContext {
  constructor(
    private readonly kernel: DreamKernel,
    public readonly pluginId: string,
  ) {}

  get logger(): Logger {
    return this.kernel.logger;
  }

  get clock(): () => number {
    return this.kernel.clock;
  }

  on(event: string, handler: BusHandler): () => void {
    // Bus events carry memory content. Subscribing to memory/* requires the
    // recall capability — otherwise the bus would be an unguarded read side
    // channel around the deny-by-default facade.
    if (event.startsWith('memory/')) this.kernel.assertCapability(this.pluginId, 'recall');
    return this.kernel.on(event, handler);
  }

  get tools(): {
    register(tool: RegisteredTool): void;
    unregister(name: string): void;
    addPreExecuteHook(hook: ToolHook['hook']): void;
    addPostExecuteHook(hook: ToolPostHook['hook']): void;
  } {
    const kernel = this.kernel;
    const pluginId = this.pluginId;
    return {
      register(tool) {
        kernel.registerTool(pluginId, tool);
      },
      unregister(name) {
        kernel.unregisterTool(name);
      },
      addPreExecuteHook(hook) {
        kernel.addPreToolHook(pluginId, hook);
      },
      addPostExecuteHook(hook) {
        kernel.addPostToolHook(pluginId, hook);
      },
    };
  }

  get cognition(): {
    register(strategy: ReasoningStrategy): void;
  } {
    const kernel = this.kernel;
    const pluginId = this.pluginId;
    return {
      register(strategy) {
        kernel.registerStrategy(pluginId, strategy);
      },
    };
  }

  get dream(): {
    registerPass(pass: DreamPass): void;
    addPreWriteHook(hook: MemoryWriteHook['hook']): void;
    addPostReadHook(hook: MemoryReadHook['hook']): void;
  } {
    const kernel = this.kernel;
    const pluginId = this.pluginId;
    return {
      registerPass(pass) {
        kernel.addDreamPass(pluginId, pass);
      },
      addPreWriteHook(hook) {
        kernel.addPreWriteHook(pluginId, hook);
      },
      addPostReadHook(hook) {
        kernel.addPostReadHook(pluginId, hook);
      },
    };
  }

  /** Capability-checked memory facade. Undeclared operations throw. */
  get memory(): ScopedMemoryFacade {
    return new ScopedMemoryFacade(this.kernel, this.pluginId);
  }
}

export class ScopedMemoryFacade {
  constructor(
    private readonly kernel: DreamKernel,
    private readonly pluginId: string,
  ) {}

  async encode(candidate: import('@dream/core').ChunkCandidate, sessionId?: string): Promise<MemoryNode | null> {
    this.kernel.assertCapability(this.pluginId, 'encode');
    return this.kernel.encodeChunk(candidate, { pluginId: this.pluginId, sessionId });
  }

  async recall(query: string, opts: { sessionId?: string; primingOnly?: boolean } = {}): Promise<{
    nodes: RecalledNode[];
    primed: RecalledNode[];
  }> {
    this.kernel.assertCapability(this.pluginId, 'recall');
    const res = await this.kernel.recallContext(query, {
      pluginId: this.pluginId,
      sessionId: opts.sessionId,
      primingOnly: opts.primingOnly,
    });
    return { nodes: res.nodes, primed: res.primed };
  }

  async update(nodeId: string, content: string, priority: import('@dream/core').EvidencePriority, reason?: string): Promise<MemoryNode> {
    this.kernel.assertCapability(this.pluginId, 'update');
    return this.kernel.updateMemory(nodeId, content, priority, reason ?? 'plugin update', this.pluginId);
  }

  async forget(nodeId: string, reason: string): Promise<boolean> {
    this.kernel.assertCapability(this.pluginId, 'forget');
    return this.kernel.forgetMemory(nodeId, reason, this.pluginId);
  }

  async purge(nodeId: string, reason: string): Promise<boolean> {
    this.kernel.assertCapability(this.pluginId, 'purge');
    return this.kernel.purgeMemory(nodeId, reason, this.pluginId);
  }

  async selfSummary(): Promise<string> {
    this.kernel.assertCapability(this.pluginId, 'selfRead');
    return this.kernel.self.summarize();
  }
}
