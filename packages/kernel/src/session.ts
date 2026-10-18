import type { ChunkCandidate, DreamReport, EvidencePriority, MemoryNode, TraceStep } from '@dream/core';
import {
  ReconsolidationWindowClosedError,
  SupersededMemoryError,
  bindSkillArgs,
  cosineSimilarity,
  newId,
} from '@dream/core';
import type { DreamKernel } from './kernel';
import type {
  ReasoningRequest,
  ReasoningStrategy,
  RecalledNode,
  Thought,
} from './types';
import type { StrategyGraph } from '@dream/core';

export interface SessionOptions {
  sessionId?: string;
  /** Context seeds activate the relevant memory subset at session start. */
  contextSeeds?: string[];
}

export interface TurnOptions {
  source?: 'user' | 'agent' | 'tool';
  /** User-stated stable fact -> encoded as semantic memory immediately. */
  explicitFact?: boolean;
  /** Task classification enabling implicit skill execution. */
  taskType?: string;
  /** Execution environment (repo, account, cluster, staging/prod) for skill boundaries. */
  environment?: string;
  /** Verbatim source text stored alongside a summarized explicit fact. */
  details?: string;
  /** Event time / validity interval and initial confidence. */
  eventTime?: number;
  validFrom?: number;
  validUntil?: number;
  confidence?: number;
  /** Explicit discussion episode; omitted -> time-gap segmentation. */
  episodeId?: string;
  /** Replaying the same key returns the existing node instead of writing twice. */
  idempotencyKey?: string;
}

export interface TurnResult {
  traceId: string;
  final: string;
  steps: TraceStep[];
  toolResults: unknown[];
  recalled: RecalledNode[];
  reasoningCalls: number;
  skillUsed: string | null;
}

export interface SessionEndResult {
  encoded: number;
  dreamReport: DreamReport | null;
}

const LOOP_THRESHOLD = 2;

/**
 * The executive: an event-driven turn loop over working memory. There is no
 * monolithic control loop — the executive only schedules: it matches learned
 * skills (implicit, no LLM), otherwise delegates to the registered reasoning
 * strategy (explicit thinking), routes recalls and corrections, and enforces
 * deterministic budgets and loop detection that never depend on model
 * self-discipline.
 */
export class SessionRunner {
  readonly id: string;
  private turnRecalled: RecalledNode[] = [];
  private turnFactIds: string[] = [];
  private traceId?: string;

  constructor(
    private readonly kernel: DreamKernel,
    sessionId?: string,
  ) {
    this.id = sessionId ?? newId('session');
  }

  /** Session start = an activation pattern over the unified memory space. */
  async start(opts: SessionOptions = {}): Promise<void> {
    if (!opts.contextSeeds || opts.contextSeeds.length === 0) return;
    // Priming only: entering a context pre-activates memories but is not
    // conscious recall, so it does not open reconsolidation windows.
    this.traceId = this.kernel.newTraceId();
    const res = await this.kernel.recallContext(opts.contextSeeds.join('\n'), {
      pluginId: 'session',
      sessionId: this.id,
      primingOnly: true,
      traceId: this.traceId,
    });
    for (const candidate of res.workingCandidates) {
      const evicted = this.kernel.wm.attend(candidate);
      await this.encodeEvicted(evicted);
    }
  }

  async submit(text: string, opts: TurnOptions = {}): Promise<TurnResult> {
    this.traceId = this.kernel.newTraceId();
    const result: TurnResult = {
      traceId: this.traceId,
      final: '',
      steps: [],
      toolResults: [],
      recalled: [],
      reasoningCalls: 0,
      skillUsed: null,
    };
    this.turnRecalled = [];
    this.turnFactIds = [];

    const candidate: ChunkCandidate = {
      content: text,
      kind: 'percept',
      source: opts.source ?? 'user',
      explicitFact: opts.explicitFact,
      details: opts.details,
      eventTime: opts.eventTime,
      validFrom: opts.validFrom,
      validUntil: opts.validUntil,
      confidence: opts.confidence,
      episodeId: opts.episodeId,
      idempotencyKey: opts.idempotencyKey,
      taskType: opts.taskType,
      priority: 'user',
    };
    const evicted = this.kernel.wm.attend(candidate);
    await this.encodeEvicted(evicted);
    if (opts.explicitFact) {
      const encoded = await this.kernel.encodeChunk(candidate, {
        pluginId: 'session',
        sessionId: this.id,
        traceId: this.traceId,
      });
      if (encoded) this.turnFactIds.push(encoded.id);
    }

    const strategy = this.kernel.defaultStrategy();
    if (!strategy) {
      result.final = 'No reasoning strategy registered — register a cognition plugin first.';
      return result;
    }

    const callCounts = new Map<string, number>();
    let loopDetected = false;
    let traceSteps: TraceStep[] = [];
    let failed = false;

    for (let step = 0; step < this.kernel.config.maxStepsPerTurn; step++) {
      // 1. Implicit path: a learned skill for this task runs without the LLM.
      //    Parameter slots are refilled from the request text; if binding
      //    fails (missing anchors, absent literal), the skill is SKIPPED and
      //    explicit reasoning takes over — never silent stale-arg replay.
      if (result.reasoningCalls === 0) {
        const skill = await this.matchSkill(text, opts.taskType, opts.environment);
        if (skill) {
          const skillMeta = skill.meta as { taskType: string; strategy: StrategyGraph; successRate: number };
          const bound = bindSkillArgs(skill.meta, text);
          if (bound.ok) {
            result.skillUsed = skillMeta.taskType;
            const executed = await this.runSkillSteps(bound.steps, traceSteps, result);
            await this.recordTrace(
              skillMeta.taskType,
              traceSteps,
              executed ? 'success' : 'failure',
              text,
              opts.environment,
              this.turnFactIds,
            );
            await this.kernel.lifecycle.onRecalled([skill.id]);
            result.final = executed
              ? `Done via learned skill "${skillMeta.taskType}" (${traceSteps.length} step${traceSteps.length === 1 ? '' : 's'}).`
              : `Learned skill "${skillMeta.taskType}" failed partway; falling back to explicit reasoning next time.`;
            this.kernel.wm.attend({
              content: result.final,
              kind: 'conclusion',
              source: 'agent',
              meta: { skill: skillMeta.taskType },
            });
            return result;
          }
          this.kernel.logger.debug('skill skipped: binding failed', {
            taskType: skillMeta.taskType,
            reason: bound.reason,
          });
        }
      }

      // 2. Explicit path: the reasoning strategy reads the WM snapshot.
      const req: ReasoningRequest = {
        userText: text,
        sessionId: this.id,
        wm: this.kernel.wm.snapshot(),
        tools: this.kernel.toolSpecs(),
        recalledNodes: this.turnRecalled,
        selfSummary: await this.kernel.self.summarize(),
      };
      let thought: Thought;
      try {
        thought = await strategy.think(req);
      } catch (err) {
        failed = true;
        result.final = `Reasoning failed: ${String(err)}`;
        break;
      }
      result.reasoningCalls++;

      if (thought.kind === 'final') {
        const evictedConclusion = this.kernel.wm.attend({
          content: thought.content,
          kind: 'conclusion',
          source: 'agent',
        });
        await this.encodeEvicted(evictedConclusion);
        result.final = thought.content;
        break;
      }

      if (thought.kind === 'recall') {
        const res = await this.kernel.recallContext(thought.query, {
          pluginId: 'session',
          sessionId: this.id,
          traceId: this.traceId,
        });
        this.kernel.emit('memory/recall', { count: res.nodes.length, query: thought.query });
        this.turnRecalled = res.nodes;
        result.recalled = res.nodes;
        for (const c of res.workingCandidates) {
          const evictedRecall = this.kernel.wm.attend(c);
          await this.encodeEvicted(evictedRecall);
        }
        continue;
      }

      if (thought.kind === 'correct') {
        try {
          await this.kernel.updateMemory(
            thought.nodeId,
            thought.content,
            thought.priority,
            thought.reason ?? 'user correction',
          );
          const confirmation = `Memory updated: ${thought.content}`;
          const evictedCorrection = this.kernel.wm.attend({
            content: confirmation,
            kind: 'conclusion',
            source: 'agent',
            meta: { corrected: thought.nodeId },
          });
          await this.encodeEvicted(evictedCorrection);
          result.final = confirmation;
          break;
        } catch (err) {
          // Post-window correction: instead of rejecting the rewrite and
          // leaving a detached note that competes with the stale fact, create
          // a new latest version and retire the old one. A correction aimed at
          // an already-superseded record is redirected to the current version.
          const targetId =
            err instanceof ReconsolidationWindowClosedError
              ? err.nodeId
              : err instanceof SupersededMemoryError
                ? err.supersededBy
                : null;
          if (targetId !== null) {
            const evolution = await this.kernel.evolveMemory(
              targetId,
              thought.content,
              thought.priority,
              thought.reason ?? 'post-window correction',
              this.id,
            );
            result.final = evolution.superseded
              ? `Memory superseded: ${thought.content} (the previous version is kept in history).`
              : `Memory updated with a conflicting note: ${thought.content}`;
            const evictedEvolution = this.kernel.wm.attend({
              content: result.final,
              kind: 'conclusion',
              source: 'agent',
              meta: { corrected: evolution.node.id, superseded: evolution.superseded },
            });
            await this.encodeEvicted(evictedEvolution);
            break;
          }
          throw err;
        }
      }

      if (thought.kind === 'tool_calls') {
        for (const call of thought.calls) {
          if (result.toolResults.length >= this.kernel.config.maxToolCallsPerTurn) break;
          const key = JSON.stringify([call.name, call.args]);
          const count = (callCounts.get(key) ?? 0) + 1;
          callCounts.set(key, count);
          if (count > LOOP_THRESHOLD) {
            // Deterministic loop detection — never rely on model self-discipline.
            loopDetected = true;
            failed = true;
            break;
          }
          const exec = await this.kernel.executeTool(call, {
            pluginId: 'reasoning',
            sessionId: this.id,
            traceId: this.traceId,
          });
          traceSteps.push({ tool: call.name, args: call.args });
          result.steps.push({ tool: call.name, args: call.args });
          result.toolResults.push(exec.ok ? exec.result : `error: ${exec.error}`);
          const evictedTool = this.kernel.wm.attend({
            content: exec.ok
              ? `Tool ${call.name} returned: ${JSON.stringify(exec.result)?.slice(0, 500)}`
              : `Tool ${call.name} failed: ${exec.error}`,
            kind: 'tool_result',
            source: 'tool',
          });
          await this.encodeEvicted(evictedTool);
          if (!exec.ok) failed = true;
        }
        if (loopDetected) {
          result.final =
            '[SYSTEM] Repetitive tool calls detected; stopping to avoid a loop. Please change approach or answer with what is available.';
          break;
        }
        continue;
      }
    }

    if (!result.final) {
      result.final = 'Turn budget exhausted without a final answer.';
      failed = true;
    }

    if (traceSteps.length > 0) {
      await this.recordTrace(
        opts.taskType ?? 'unclassified',
        traceSteps,
        failed ? 'failure' : 'success',
        text,
        opts.environment,
        this.turnFactIds,
      );
    }
    return result;
  }

  /** Session end: residuals encode; optionally run a dream cycle. */
  async end(): Promise<SessionEndResult> {
    let encoded = 0;
    for (const chunk of this.kernel.wm.drain()) {
      if (chunk.candidate.kind === 'recalled') continue; // already lives in LTM
      if (chunk.candidate.explicitFact) continue; // encoded immediately at submit
      const node = await this.kernel.encodeChunk(chunk.candidate, {
        pluginId: 'session',
        sessionId: this.id,
        traceId: this.traceId,
      });
      if (node) encoded++;
    }
    const dreamReport = this.kernel.config.dreamOnSessionClose ? await this.kernel.dreamNow() : null;
    return { encoded, dreamReport };
  }

  // ---------------------------------------------------------------------------

  private async encodeEvicted(evicted: { candidate: ChunkCandidate } | null): Promise<void> {
    if (!evicted) return;
    if (evicted.candidate.meta?.['nodeId']) return; // LTM-backed chunk, not re-encoded
    if (evicted.candidate.explicitFact) return; // user facts encode immediately at submit
    await this.kernel.encodeChunk(evicted.candidate, {
      pluginId: 'session',
      sessionId: this.id,
      traceId: this.traceId,
    });
  }

  private async matchSkill(
    text: string,
    taskType?: string,
    environment?: string,
  ): Promise<MemoryNode | null> {
    const skills = await this.kernel.store.listNodes({
      kinds: ['procedural'],
      excludeQuarantined: true,
      minStrength: 0.1,
    });
    if (skills.length === 0) return null;

    const boundaryOk = (skill: MemoryNode): boolean => {
      if (!this.kernel.config.enforceSkillBoundaries) return true;
      const boundaries = (skill.meta?.['boundaryEnvs'] as string[] | undefined) ?? [];
      if (boundaries.length === 0) return true;
      if (!environment) return false; // unknown environment -> fail closed
      const normalized = environment.trim().toLowerCase();
      return boundaries.some((boundary) => boundary.trim().toLowerCase() === normalized);
    };
    const healthy = (skill: MemoryNode): boolean =>
      ((skill.meta?.['successRate'] as number | undefined) ?? 0) >=
      this.kernel.config.skillMinSuccessRate;

    if (taskType) {
      const match = skills.find(
        (skill) =>
          skill.meta?.['taskType'] === taskType && healthy(skill) && boundaryOk(skill),
      );
      return match ?? null;
    }

    const qv = (await this.kernel.provider.embed([text]))[0]!;
    let best: { node: MemoryNode; similarity: number } | null = null;
    for (const skill of skills) {
      if (!healthy(skill) || !boundaryOk(skill)) continue;
      const variants = [skill.content];
      if (this.kernel.config.useSkillSearchKeys) {
        const searchKeys = skill.meta?.['searchKeys'] as string[] | undefined;
        if (searchKeys && searchKeys.length > 0) variants.push(searchKeys.join(' '));
      }
      const vectors = await this.kernel.provider.embed(variants);
      const similarity = Math.max(...vectors.map((vector) => cosineSimilarity(qv, vector)));
      if (
        similarity >= this.kernel.config.skillSimilarityThreshold &&
        (!best || similarity > best.similarity)
      ) {
        best = { node: skill, similarity };
      }
    }
    return best?.node ?? null;
  }

  private async runSkillSteps(
    steps: TraceStep[],
    traceSteps: TraceStep[],
    result: TurnResult,
  ): Promise<boolean> {
    let ok = true;
    for (const stepDef of steps) {
      const exec = await this.kernel.executeTool(
        { name: stepDef.tool, args: stepDef.args },
        { pluginId: 'skill', sessionId: this.id, traceId: this.traceId },
      );
      traceSteps.push({ tool: stepDef.tool, args: stepDef.args });
      result.steps.push({ tool: stepDef.tool, args: stepDef.args });
      result.toolResults.push(exec.ok ? exec.result : `error: ${exec.error}`);
      const evicted = this.kernel.wm.attend({
        content: exec.ok
          ? `Tool ${stepDef.tool} returned: ${JSON.stringify(exec.result)?.slice(0, 500)}`
          : `Tool ${stepDef.tool} failed: ${exec.error}`,
        kind: 'tool_result',
        source: 'tool',
      });
      await this.encodeEvicted(evicted);
      if (!exec.ok) {
        ok = false;
        break;
      }
    }
    return ok;
  }

  private async recordTrace(
    taskType: string,
    steps: TraceStep[],
    outcome: 'success' | 'failure',
    percept?: string,
    environment?: string,
    factIds?: string[],
  ): Promise<void> {
    await this.kernel.traces.appendTrace({
      id: this.kernel.traceId(),
      taskType,
      steps,
      outcome,
      ts: this.kernel.clock(),
      sessionId: this.id,
      percept,
      environment,
      factIds,
    });
  }
}

export type { EvidencePriority, ReasoningStrategy };
