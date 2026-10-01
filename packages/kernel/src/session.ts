import type { ChunkCandidate, DreamReport, EvidencePriority, MemoryNode, TraceStep } from '@dream/core';
import { ReconsolidationWindowClosedError, bindSkillArgs, newId } from '@dream/core';
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
}

export interface TurnResult {
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
    const res = await this.kernel.recallContext(opts.contextSeeds.join('\n'), {
      pluginId: 'session',
      sessionId: this.id,
      primingOnly: true,
    });
    for (const candidate of res.workingCandidates) {
      const evicted = this.kernel.wm.attend(candidate);
      await this.encodeEvicted(evicted);
    }
  }

  async submit(text: string, opts: TurnOptions = {}): Promise<TurnResult> {
    const result: TurnResult = {
      final: '',
      steps: [],
      toolResults: [],
      recalled: [],
      reasoningCalls: 0,
      skillUsed: null,
    };
    this.turnRecalled = [];

    const candidate: ChunkCandidate = {
      content: text,
      kind: 'percept',
      source: opts.source ?? 'user',
      explicitFact: opts.explicitFact,
      taskType: opts.taskType,
      priority: 'user',
    };
    const evicted = this.kernel.wm.attend(candidate);
    await this.encodeEvicted(evicted);
    if (opts.explicitFact) {
      await this.kernel.encodeChunk(candidate, { pluginId: 'session', sessionId: this.id });
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
        const skill = await this.matchSkill(text, opts.taskType);
        if (skill) {
          const skillMeta = skill.meta as { taskType: string; strategy: StrategyGraph; successRate: number };
          const bound = bindSkillArgs(skill.meta, text);
          if (bound.ok) {
            result.skillUsed = skillMeta.taskType;
            const executed = await this.runSkillSteps(bound.steps, traceSteps, result);
            await this.recordTrace(skillMeta.taskType, traceSteps, executed ? 'success' : 'failure', text);
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
          if (err instanceof ReconsolidationWindowClosedError) {
            result.final =
              'That memory has settled and can no longer be rewritten in place; I recorded the new information as a linked note instead.';
            await this.kernel.encodeChunk(
              { content: thought.content, kind: 'percept', source: 'user', priority: 'user' },
              { pluginId: 'session', sessionId: this.id },
            );
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
          const exec = await this.kernel.executeTool(call, { pluginId: 'reasoning', sessionId: this.id });
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
      await this.recordTrace(opts.taskType ?? 'unclassified', traceSteps, failed ? 'failure' : 'success', text);
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
    await this.kernel.encodeChunk(evicted.candidate, { pluginId: 'session', sessionId: this.id });
  }

  private async matchSkill(text: string, taskType?: string): Promise<MemoryNode | null> {
    const skills = await this.kernel.store.listNodes({
      kinds: ['procedural'],
      excludeQuarantined: true,
      minStrength: 0.1,
    });
    if (skills.length === 0) return null;

    if (taskType) {
      const match = skills.find(
        (s) =>
          s.meta?.['taskType'] === taskType &&
          ((s.meta?.['successRate'] as number | undefined) ?? 0) >= this.kernel.config.skillMinSuccessRate,
      );
      return match ?? null;
    }

    const qv = (await this.kernel.provider.embed([text]))[0]!;
    const hits = await this.kernel.store.searchByEmbedding(qv, 1, {
      kinds: ['procedural'],
      excludeQuarantined: true,
      minStrength: 0.1,
    });
    const hit = hits[0];
    if (!hit) return null;
    if (hit.similarity < this.kernel.config.skillSimilarityThreshold) return null;
    if (((hit.node.meta?.['successRate'] as number | undefined) ?? 0) < this.kernel.config.skillMinSuccessRate) {
      return null;
    }
    return hit.node;
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
        { pluginId: 'skill', sessionId: this.id },
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
  ): Promise<void> {
    await this.kernel.traces.appendTrace({
      id: this.kernel.traceId(),
      taskType,
      steps,
      outcome,
      ts: this.kernel.clock(),
      sessionId: this.id,
      percept,
    });
  }
}

export type { EvidencePriority, ReasoningStrategy };
