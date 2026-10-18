import {
  ActivationEngine,
  EncodingGate,
  LifecycleEngine,
  SelfModelManager,
  WorkingMemory,
  PolicyViolationError,
  InMemoryTracer,
  NoopTracer,
  PersistentTracer,
  extractRevisions,
  newId,
  resolveRetrievalProfile,
  sha256Hex,
  traceMetrics,
  type DreamReport,
  type EmbeddingProvider,
  type EvolutionResult,
  type QueryRewriter,
  type RetrievalProfileOptions,
  type RevisionRecord,
  type RevisionStore,
  type TraceEvent,
  type TraceMetrics,
  type TraceStage,
  type Tracer,
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
  revisions?: RevisionStore;
  tracer?: Tracer;
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
  readonly revisions?: RevisionStore;
  readonly tracer: Tracer;
  readonly provider: EmbeddingProvider;
  readonly config: ResolvedDreamConfig;
  readonly wm: WorkingMemory;
  /** Resolved channel defaults from the selected profile plus explicit knobs. */
  readonly retrieval: RetrievalProfileOptions;
  readonly policy: MemoryPolicyEngine;
  readonly gate: EncodingGate;
  /** Shared so the hybrid channel's token cache survives across recalls. */
  readonly activation: ActivationEngine;
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
  private readonly queryRewriters: Array<{ pluginId: string; rewriter: QueryRewriter }> = [];
  private readonly bus = new Map<string, Set<BusHandler>>();
  private readonly injection = new InjectionHeuristics();
  private readonly scrubber: SecretScrubber | null;
  private lastReport: DreamReport | null = null;

  constructor(components: DreamComponents, configInput?: Record<string, unknown>) {
    this.store = components.memory;
    this.journal = components.journal;
    this.traces = components.traces;
    this.revisions = components.revisions;
    this.provider = components.provider;
    this.clock = components.clock ?? Date.now;
    this.config = dreamConfigSchema.parse(configInput ?? {});
    const raw = configInput ?? {};
    const overrides: Partial<RetrievalProfileOptions> = {};
    if ('lexicalWeight' in raw) overrides.lexicalWeight = this.config.lexicalWeight;
    if ('tagWeight' in raw) overrides.tagWeight = this.config.tagWeight;
    if ('episodeWeight' in raw) overrides.episodeWeight = this.config.episodeWeight;
    if ('retrievalFusion' in raw) overrides.fusion = this.config.retrievalFusion;
    if ('retrievalReservedKinds' in raw) {
      overrides.reservedKinds = this.config.retrievalReservedKinds;
    }
    if ('retrievalMaxPerKind' in raw) {
      overrides.maxPerKind = this.config.retrievalMaxPerKind as RetrievalProfileOptions['maxPerKind'];
    }
    if ('retrievalRelationPriors' in raw) {
      overrides.relationPriors =
        this.config.retrievalRelationPriors as RetrievalProfileOptions['relationPriors'];
    }
    if ('retrievalDegreeNormalize' in raw) {
      overrides.degreeNormalize = this.config.retrievalDegreeNormalize;
    }
    this.retrieval = resolveRetrievalProfile(this.config.retrievalProfile, overrides);
    this.logger = components.logger ?? new SilentLogger();
    const baseTracer =
      components.tracer ??
      (this.config.traceEnabled ? new InMemoryTracer() : new NoopTracer());
    this.tracer =
      this.config.tracePersist && baseTracer.enabled
        ? new PersistentTracer(baseTracer, this.journal, (err) =>
            this.logger.warn('trace persist failed', { error: String(err) }),
          )
        : baseTracer;
    this.approval = components.approval;
    this.policy = new MemoryPolicyEngine(this.config.preset, components.approval);
    this.scrubber = this.config.scrubSecrets ? new SecretScrubber() : null;

    this.wm = new WorkingMemory(this.config.wmCapacity, this.clock);
    this.gate = new EncodingGate(
      this.store,
      this.journal,
      this.provider,
      undefined,
      this.clock,
      this.config.episodeGapMs,
      this.config.typedRelations,
    );
    this.activation = new ActivationEngine(this.provider);
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
    await plugin.apply(this.contextFor(plugin.name));
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
    opts: {
      pluginId: string;
      sessionId?: string;
      traceId?: string;
      idempotencyKey?: string;
    } = { pluginId: 'kernel' },
  ): Promise<MemoryNode | null> {
    const traceId = opts.traceId ?? this.newTraceId();
    const started = performance.now();
    const mutable: { content: string; meta: Record<string, unknown> } = {
      content: candidate.content,
      meta: { ...(candidate.meta as Record<string, unknown> | undefined), traceId },
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
        idempotencyKey: opts.idempotencyKey ?? candidate.idempotencyKey,
      },
      { sessionId: opts.sessionId, userId: this.config.userId, scene: this.config.scene },
    );
    if (node) {
      this.emit('memory/encode', { nodeId: node.id, kind: node.kind, pluginId: opts.pluginId, content: node.content });
    }
    this.emitTrace('encode', traceId, performance.now() - started, {
      kind: node?.kind ?? candidate.kind,
      stored: node !== null,
      contentHash: sha256Hex(mutable.content),
      contentLength: mutable.content.length,
      quarantined: node?.quarantined === true,
    });
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
      scene?: string;
      traceId?: string;
      asOf?: number;
      createdAfter?: number;
    } = { pluginId: 'kernel' },
  ): Promise<{
    nodes: RecalledNode[];
    primed: RecalledNode[];
    workingCandidates: import('@dream/core').ChunkCandidate[];
    traceId: string;
  }> {
    const traceId = opts.traceId ?? this.newTraceId();
    const started = performance.now();
    const decision = await this.decide({ type: 'recall', pluginId: opts.pluginId });
    if (decision !== 'allow') return { nodes: [], primed: [], workingCandidates: [], traceId };

    let effectiveQuery = query;
    for (const { pluginId, rewriter } of this.queryRewriters) {
      const rewriteStarted = performance.now();
      const before = effectiveQuery;
      try {
        effectiveQuery = await rewriter.rewrite(effectiveQuery);
      } catch (err) {
        this.logger.warn('query rewriter failed; keeping previous query', {
          pluginId,
          rewriter: rewriter.id,
          error: String(err),
        });
      }
      this.emitTrace('query-rewrite', traceId, performance.now() - rewriteStarted, {
        rewriter: rewriter.id,
        changed: effectiveQuery !== before,
        queryHash: sha256Hex(effectiveQuery),
      });
    }

    const engine = this.activation;
    const set = await engine.activate(this.store, [effectiveQuery], {
      capacity: opts.capacity ?? this.config.wmCapacity,
      excludeSessionId: opts.sessionId,
      now: this.clock,
      lexicalWeight: this.retrieval.lexicalWeight,
      lexicalMinScore: this.config.lexicalMinScore,
      tagWeight: this.retrieval.tagWeight,
      episodeWeight: this.retrieval.episodeWeight,
      diversityThreshold: this.config.retrievalDiversityThreshold,
      diversityKinds: this.config.retrievalDiversityKinds,
      reservedKinds: this.retrieval.reservedKinds,
      maxPerKind: this.retrieval.maxPerKind,
      fusion: this.retrieval.fusion,
      rrfK: this.config.rrfK,
      relationPriors: this.retrieval.relationPriors,
      degreeNormalize: this.retrieval.degreeNormalize,
      userId: this.config.userId,
      scene: opts.scene ?? this.config.scene,
      tracer: this.tracer,
      traceId,
      asOf: opts.asOf,
      createdAfter: opts.createdAfter,
    });

    const toNode = async (candidate: import('@dream/core').ChunkCandidate, primed: boolean): Promise<RecalledNode> => ({
      id: candidate.meta?.['nodeId'] as string,
      content: candidate.content,
      kind: candidate.meta?.['nodeKind'] as RecalledNode['kind'],
      scope: candidate.meta?.['scope'] as RecalledNode['scope'],
      primed,
      details: this.config.returnDetails
        ? (candidate.meta?.['details'] as string | undefined)
        : undefined,
      relationPath: candidate.meta?.['relationPath'] as RecalledNode['relationPath'],
    });

    const nodes: RecalledNode[] = [];
    for (const c of set.workingSet) nodes.push(await toNode(c, false));
    const primed: RecalledNode[] = [];
    for (const c of set.primed) primed.push(await toNode(c, true));

    for (const node of [...nodes, ...primed]) {
      for (const { hook } of this.postReadHooks) hook(node);
    }

    if (this.revisions && this.config.attachRevisions) {
      for (const recalled of nodes) {
        const stored = await this.store.getNode(recalled.id);
        const rawKeys = stored?.meta?.['artifactKeys'];
        const single = stored?.meta?.['artifactKey'];
        const keys = [
          ...(Array.isArray(rawKeys) ? rawKeys.filter((key): key is string => typeof key === 'string') : []),
          ...(typeof single === 'string' ? [single] : []),
        ];
        if (keys.length === 0) continue;
        const records: RevisionRecord[] = [];
        for (const key of new Set(keys)) {
          records.push(...(await this.revisions.listRevisions(key)));
        }
        if (records.length > 0) {
          recalled.revisions = records;
          this.emitTrace('revision', traceId, undefined, {
            nodeId: recalled.id,
            artifactKeys: keys.length,
            revisions: records.length,
          });
        }
      }
    }

    if (this.config.attachTriLinks) {
      for (const recalled of nodes) {
        const stored = await this.store.getNode(recalled.id);
        if (!stored) continue;
        const experienceIds = (
          (stored.meta?.['derivedExperienceIds'] as string[] | undefined) ?? []
        ).slice(0, 5);
        const experiences: NonNullable<RecalledNode['relatedExperiences']> = [];
        for (const id of experienceIds) {
          const experience = await this.store.getNode(id);
          if (!experience || experience.isLatest === false) continue;
          experiences.push({
            id,
            content: experience.content,
            taskType: experience.meta?.['taskType'] as string | undefined,
            successRate: experience.meta?.['successRate'] as number | undefined,
          });
        }
        if (experiences.length > 0) recalled.relatedExperiences = experiences;

        if (stored.kind === 'procedural') {
          const factIds = (
            (stored.meta?.['sourceFactIds'] as string[] | undefined) ?? []
          ).slice(0, 5);
          const facts: NonNullable<RecalledNode['sourceFacts']> = [];
          for (const id of factIds) {
            const fact = await this.store.getNode(id);
            if (!fact) continue;
            facts.push({ id, content: fact.content });
          }
          if (facts.length > 0) recalled.sourceFacts = facts;
        }
      }
    }

    if (!opts.primingOnly && nodes.length > 0) {
      await this.lifecycle.onRecalled(nodes.map((n) => n.id));
    }

    this.emitTrace('recall', traceId, performance.now() - started, {
      queryHash: sha256Hex(query),
      working: nodes.length,
      primed: primed.length,
      primingOnly: opts.primingOnly === true,
      scene: opts.scene ?? this.config.scene,
    });

    return {
      nodes,
      primed,
      workingCandidates: set.workingSet,
      traceId,
    };
  }

  async updateMemory(
    nodeId: string,
    content: string,
    priority: import('@dream/core').EvidencePriority,
    reason: string,
    sessionId?: string,
  ): Promise<MemoryNode> {
    const decision = await this.decide({ type: 'update', nodeId });
    if (decision !== 'allow') throw new PolicyViolationError('policy', 'update denied by policy');
    return this.lifecycle.applyUpdate(nodeId, { content, priority, reason, sessionId });
  }

  /**
   * Post-window correction: create a new latest version and retire the old one.
   * Current recall never sees the stale version; the chain stays auditable.
   */
  async evolveMemory(
    nodeId: string,
    content: string,
    priority: import('@dream/core').EvidencePriority,
    reason: string,
    sessionId?: string,
  ): Promise<EvolutionResult> {
    const decision = await this.decide({ type: 'update', nodeId });
    if (decision !== 'allow') throw new PolicyViolationError('policy', 'update denied by policy');
    return this.lifecycle.supersedeMemory(nodeId, { content, priority, reason, sessionId });
  }

  /** TriLink: link a fact to the experience it produced. */
  async linkFactToExperience(
    factId: string,
    experienceId: string,
  ): Promise<{ fact: MemoryNode; experience: MemoryNode }> {
    const decision = await this.decide({ type: 'update', nodeId: factId });
    if (decision !== 'allow') throw new PolicyViolationError('policy', 'update denied by policy');
    return this.lifecycle.linkFactToExperience(factId, experienceId);
  }

  /** TriLink: attach a revision to its task fact (and optionally experience). */
  async linkRevision(
    revisionId: string,
    links: { factId?: string; experienceId?: string },
  ): Promise<RevisionRecord | null> {
    if (!this.revisions?.updateRevisionLinks) {
      throw new Error('revision store does not support link updates');
    }
    return this.revisions.updateRevisionLinks(revisionId, {
      sourceFactIds: links.factId ? [links.factId] : [],
      derivedExperienceIds: links.experienceId ? [links.experienceId] : [],
    });
  }

  /** Version history of a record, oldest -> newest. */
  async memoryHistory(nodeId: string): Promise<MemoryNode[]> {
    const decision = await this.decide({ type: 'recall', nodeId });
    if (decision !== 'allow') throw new PolicyViolationError('policy', 'recall denied by policy');
    return this.lifecycle.versionChain(nodeId);
  }

  async forgetMemory(nodeId: string, reason: string): Promise<boolean> {
    const decision = await this.decide({ type: 'forget', nodeId });
    if (decision !== 'allow') return false;
    return this.lifecycle.hardForget(nodeId, reason);
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

  newTraceId(): string {
    return newId('trace');
  }

  private emitTrace(
    stage: TraceStage,
    traceId: string,
    durationMs?: number,
    meta?: Record<string, string | number | boolean | undefined>,
  ): void {
    if (!this.tracer.enabled) return;
    this.tracer.event({ traceId, stage, ts: this.clock(), durationMs, meta });
  }

  traceEvents(traceId?: string): TraceEvent[] {
    return this.tracer.list(traceId);
  }

  traceMetrics(traceId?: string): TraceMetrics {
    return traceMetrics(this.tracer.list(traceId));
  }

  /** Retention: drop persisted trace events older than `days` (audit is kept). */
  async pruneTraces(days = this.config.traceRetentionDays): Promise<number> {
    if (!this.journal.pruneTraces) return 0;
    return this.journal.pruneTraces(this.clock() - days * 24 * 60 * 60 * 1000);
  }

  // -------------------------------------------------------------------------
  // Tool pipeline — the single waterfall, no second door
  // -------------------------------------------------------------------------

  async executeTool(
    call: { name: string; args: unknown },
    opts: { pluginId: string; sessionId?: string; traceId?: string } = { pluginId: 'kernel' },
  ): Promise<ToolExecutionResult> {
    const traceId = opts.traceId ?? this.newTraceId();
    const started = performance.now();
    const tool = this.toolRegistry.get(call.name);
    const ctx: ToolCallCtx = { name: call.name, args: call.args, pluginId: opts.pluginId, sessionId: opts.sessionId };
    if (!tool) {
      this.emitTrace('tool', traceId, performance.now() - started, {
        tool: call.name,
        ok: false,
        reason: 'unknown',
      });
      return { ok: false, error: `unknown tool "${call.name}"` };
    }

    for (const { pluginId, hook } of this.preToolHooks) {
      const decision = await hook(ctx);
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

    let result: unknown;
    try {
      result = await tool.handler(call.args, { sessionId: opts.sessionId });
    } catch (err) {
      this.emit('tool/execute', { ...ctx, error: String(err) });
      this.emitTrace('tool', traceId, performance.now() - started, {
        tool: call.name,
        ok: false,
        reason: 'handler-error',
      });
      return { ok: false, error: String(err) };
    }

    const resultCtx: ToolResultCtx = { ...ctx, result };
    for (const { hook } of this.postToolHooks) {
      const replacement = hook(resultCtx);
      if (replacement !== undefined) resultCtx.result = replacement;
    }

    if (this.revisions) {
      const revisionInputs = extractRevisions(call.name, call.args, {
        sessionId: opts.sessionId,
        ts: this.clock(),
      });
      for (const input of revisionInputs) {
        const record = await this.revisions.appendRevision(input);
        await this.journal.append({
          ts: record.ts,
          type: 'revision',
          nodeId: record.id,
          meta: { artifactKey: record.artifactKey, version: record.version, tool: record.tool },
        });
        this.emit('revision/record', record);
      }
    }

    this.emitTrace('tool', traceId, performance.now() - started, {
      tool: call.name,
      ok: true,
      argsHash: sha256Hex(JSON.stringify(call.args ?? null)),
    });
    this.emit('tool/execute', { ...ctx, ok: true });
    return { ok: true, result: resultCtx.result };
  }

  toolSpecs(): ToolSpec[] {
    return [...this.toolRegistry.values()].map(({ name, description, parameters }) => ({
      name,
      description,
      parameters,
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
    const traceId = this.newTraceId();
    const started = performance.now();
    const report = await this.lifecycle.dream();
    report.traceId = traceId;
    for (const { pluginId, pass } of this.passes) {
      try {
        await pass.run(report);
      } catch (err) {
        this.logger.error('dream pass failed', { pluginId, pass: pass.name, error: String(err) });
      }
    }
    this.lastReport = report;
    this.emit('dream/report', report);
    this.logger.info('dream cycle complete', {
      episodes: report.replayedEpisodes,
      abstractions: report.abstractions.length,
      skillsFormed: report.skillsFormed.length,
    });
    const prunedTraces = await this.pruneTraces();
    this.emitTrace('dream', traceId, performance.now() - started, {
      replayed: report.replayedEpisodes,
      abstractions: report.abstractions.length,
      merged: report.mergedCount,
      skillsFormed: report.skillsFormed.length,
      skillsUpdated: report.skillsUpdated.length,
      faded: report.fadedCount,
      prunedTraces,
    });
    return report;
  }

  lastDreamReport(): DreamReport | null {
    return this.lastReport;
  }

  async stats(): Promise<{ kind: string; count: number }[]> {
    const nodes = await this.store.listNodes({ userId: this.config.userId });
    const counts = new Map<string, number>();
    for (const node of nodes) counts.set(node.kind, (counts.get(node.kind) ?? 0) + 1);
    return [...counts.entries()].map(([kind, count]) => ({ kind, count }));
  }

  // Internals used by DreamContext -------------------------------------------------

  registerTool(pluginId: string, tool: RegisteredTool): void {
    if (this.toolRegistry.has(tool.name)) {
      throw new Error(`tool "${tool.name}" already registered (by another plugin?)`);
    }
    this.toolRegistry.set(tool.name, tool);
  }

  registerStrategy(pluginId: string, strategy: ReasoningStrategy): void {
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

  addQueryRewriter(pluginId: string, rewriter: QueryRewriter): void {
    this.queryRewriters.push({ pluginId, rewriter });
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
    return this.kernel.on(event, handler);
  }

  get tools(): {
    register(tool: RegisteredTool): void;
    addPreExecuteHook(hook: ToolHook['hook']): void;
    addPostExecuteHook(hook: ToolPostHook['hook']): void;
  } {
    const kernel = this.kernel;
    const pluginId = this.pluginId;
    return {
      register(tool) {
        kernel.registerTool(pluginId, tool);
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

  get retrieval(): {
    addQueryRewriter(rewriter: QueryRewriter): void;
  } {
    const kernel = this.kernel;
    const pluginId = this.pluginId;
    return {
      addQueryRewriter(rewriter) {
        kernel.addQueryRewriter(pluginId, rewriter);
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

  async recall(query: string, opts: {
    sessionId?: string;
    primingOnly?: boolean;
    scene?: string;
    asOf?: number;
    createdAfter?: number;
  } = {}): Promise<{
    nodes: RecalledNode[];
    primed: RecalledNode[];
  }> {
    this.kernel.assertCapability(this.pluginId, 'recall');
    const res = await this.kernel.recallContext(query, {
      pluginId: this.pluginId,
      sessionId: opts.sessionId,
      primingOnly: opts.primingOnly,
      scene: opts.scene,
      asOf: opts.asOf,
      createdAfter: opts.createdAfter,
    });
    return { nodes: res.nodes, primed: res.primed };
  }

  async update(nodeId: string, content: string, priority: import('@dream/core').EvidencePriority, reason?: string): Promise<MemoryNode> {
    this.kernel.assertCapability(this.pluginId, 'update');
    return this.kernel.updateMemory(nodeId, content, priority, reason ?? 'plugin update');
  }

  async evolve(nodeId: string, content: string, priority: import('@dream/core').EvidencePriority, reason?: string): Promise<EvolutionResult> {
    this.kernel.assertCapability(this.pluginId, 'update');
    return this.kernel.evolveMemory(nodeId, content, priority, reason ?? 'plugin revision');
  }

  async history(nodeId: string): Promise<MemoryNode[]> {
    this.kernel.assertCapability(this.pluginId, 'recall');
    return this.kernel.memoryHistory(nodeId);
  }

  async forget(nodeId: string, reason: string): Promise<boolean> {
    this.kernel.assertCapability(this.pluginId, 'forget');
    return this.kernel.forgetMemory(nodeId, reason);
  }

  async selfSummary(): Promise<string> {
    this.kernel.assertCapability(this.pluginId, 'selfRead');
    return this.kernel.self.summarize();
  }
}
