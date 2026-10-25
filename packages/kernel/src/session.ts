import type { ChunkCandidate, DreamReport, EvidencePriority, MemoryNode, TraceStep } from '@dream/core';
import {
  NotFoundError,
  PolicyViolationError,
  ReconsolidationWindowClosedError,
  WorkingMemory,
  bindSkillArgs,
  newId,
} from '@dream/core';
import type { DreamKernel } from './kernel';
import type {
  ConversationTurn,
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
 * Key-property-order-independent JSON key for loop detection. JSON.stringify
 * alone made the guardrail sensitive to accidental insertion order and so
 * trivially evadable without the model even trying.
 */
function stableKey(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableKey(record[k])}`).join(',')}}`;
}

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
  /** Each session owns its attention bus; connections must not share one. */
  readonly wm: WorkingMemory;
  private turnRecalled: RecalledNode[] = [];
  private readonly conversation: ConversationTurn[] = [];
  private turnChain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly kernel: DreamKernel,
    sessionId?: string,
  ) {
    this.id = sessionId ?? newId('session');
    this.wm = new WorkingMemory(kernel.config.wmCapacity, kernel.clock);
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
      const evicted = this.wm.attend(candidate);
      await this.encodeEvicted(evicted);
    }
  }

  async submit(text: string, opts: TurnOptions = {}): Promise<TurnResult> {
    // Serialize turns on one session: overlapping submits used to interleave
    // turnRecalled and working-memory mutations. Callers queue and await each
    // other's turn; a rejected turn does not poison the chain.
    const run = this.turnChain.then(() => this.runTurn(text, opts));
    this.turnChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async runTurn(text: string, opts: TurnOptions): Promise<TurnResult> {
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
    const evicted = this.wm.attend(candidate);
    await this.encodeEvicted(evicted);

    // Retrieval is part of every turn, not an optional model trick. This is
    // what actually connects live OpenAI reasoning to the memory kernel.
    // Run it BEFORE encoding an explicit fact from this same message, so the
    // model is not told "you already told me" about the sentence it just read.
    const recall = await this.kernel.recallContext(text, {
      pluginId: 'session',
      sessionId: this.id,
    });
    this.turnRecalled = recall.nodes;
    result.recalled = recall.nodes;
    this.kernel.emit('memory/recall', {
      count: recall.nodes.length,
      query: text,
      sessionId: this.id,
    });
    for (const recalledCandidate of recall.workingCandidates) {
      const evicted = this.wm.attend(recalledCandidate);
      await this.encodeEvicted(evicted);
    }

    if (opts.explicitFact) {
      await this.kernel.encodeChunk(candidate, { pluginId: 'session', sessionId: this.id });
    }

    const strategy = this.kernel.defaultStrategy();
    if (!strategy) {
      result.final = 'No reasoning strategy registered — register a cognition plugin first.';
      this.remember(text, result.final);
      return result;
    }

    const callCounts = new Map<string, number>();
    let loopDetected = false;
    let capReached = false;
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
              : `Learned skill "${skillMeta.taskType}" stopped: a step was denied or failed. Not continuing automatically.`;
            this.wm.attend({
              content: result.final,
              kind: 'conclusion',
              source: 'agent',
              meta: { skill: skillMeta.taskType },
            });
            this.remember(text, result.final);
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
        wm: this.wm.snapshot(),
        tools: this.kernel.toolSpecs(),
        conversation: this.conversation.slice(-(this.kernel.config.maxConversationTurns * 2)),
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
        const evictedConclusion = this.wm.attend({
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
        this.kernel.emit('memory/recall', {
          count: res.nodes.length,
          query: thought.query,
          sessionId: this.id,
        });
        this.turnRecalled = res.nodes;
        result.recalled = res.nodes;
        for (const c of res.workingCandidates) {
          const evictedRecall = this.wm.attend(c);
          await this.encodeEvicted(evictedRecall);
        }
        continue;
      }

      if (thought.kind === 'correct') {
        const outcome = await this.correctMemory(thought.nodeId, thought.content, thought.priority, thought.reason ?? 'user correction');
        const confirmation = outcome.message;
        const evictedCorrection = this.wm.attend({
          content: confirmation,
          kind: 'conclusion',
          source: 'agent',
          meta: { corrected: thought.nodeId },
        });
        await this.encodeEvicted(evictedCorrection);
        result.final = confirmation;
        break;
      }

      if (thought.kind === 'tool_calls') {
        if (capReached) {
          // The cap already fired and the model still wants tools: stop here
          // instead of letting the step loop re-ask the strategy while
          // silently executing nothing.
          result.final =
            '[SYSTEM] Tool-call budget for this turn is exhausted; stopping. Answer with what is available.';
          failed = true;
          break;
        }
        for (const call of thought.calls) {
          if (result.toolResults.length >= this.kernel.config.maxToolCallsPerTurn) {
            capReached = true;
            break;
          }
          const key = `${call.name}|${stableKey(call.args)}`;
          const count = (callCounts.get(key) ?? 0) + 1;
          callCounts.set(key, count);
          if (count > LOOP_THRESHOLD) {
            // Deterministic loop detection — never rely on model self-discipline.
            loopDetected = true;
            failed = true;
            break;
          }

          // Memory control calls are dispatched inline by the executive —
          // they are not registry tools. A mixed batch (memory + regular) is
          // processed call by call so neither half is silently dropped.
          if (call.name === 'memory_recall') {
            const q = (call.args as { query?: unknown } | undefined)?.query;
            const res = await this.kernel.recallContext(typeof q === 'string' && q ? q : text, {
              pluginId: 'session',
              sessionId: this.id,
            });
            this.turnRecalled = res.nodes;
            result.recalled = [...result.recalled, ...res.nodes];
            result.toolResults.push(`recalled ${res.nodes.length} memory(ies)`);
            for (const c of res.workingCandidates) {
              const evictedRecall = this.wm.attend(c);
              await this.encodeEvicted(evictedRecall);
            }
            continue;
          }
          if (call.name === 'memory_correct') {
            const args = (call.args ?? {}) as { nodeId?: unknown; content?: unknown; reason?: unknown };
            const nodeId = typeof args.nodeId === 'string' ? args.nodeId : '';
            const content = typeof args.content === 'string' ? args.content : '';
            const outcome =
              nodeId && content
                ? await this.correctMemory(nodeId, content, 'user', typeof args.reason === 'string' ? args.reason : 'user correction')
                : { ok: false, message: 'memory_correct requires nodeId and content from the recalled-memory block.' };
            result.toolResults.push(outcome.message);
            const evictedCorrection = this.wm.attend({
              content: outcome.message,
              kind: 'tool_result',
              source: 'tool',
            });
            await this.encodeEvicted(evictedCorrection);
            if (!outcome.ok) failed = true;
            continue;
          }

          const exec = await this.kernel.executeTool(call, { pluginId: 'reasoning', sessionId: this.id });
          traceSteps.push({ tool: call.name, args: call.args });
          result.steps.push({ tool: call.name, args: call.args });
          result.toolResults.push(exec.ok ? exec.result : `error: ${exec.error}`);
          const evictedTool = this.wm.attend({
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
    this.remember(text, result.final);
    return result;
  }

  /**
   * In-place rewrite through the reconsolidation window. Every failure mode
   * (window closed, node gone, policy denial) degrades to a linked note —
   * none of them may throw out of submit() and drop the user's message.
   */
  private async correctMemory(
    nodeId: string,
    content: string,
    priority: EvidencePriority,
    reason: string,
  ): Promise<{ ok: boolean; message: string }> {
    try {
      await this.kernel.updateMemory(nodeId, content, priority, reason);
      return { ok: true, message: `Memory updated: ${content}` };
    } catch (err) {
      const settled = err instanceof ReconsolidationWindowClosedError;
      const gone = err instanceof NotFoundError;
      const blocked = err instanceof PolicyViolationError;
      if (!settled && !gone && !blocked) throw err;
      const message = settled
        ? 'That memory has settled and can no longer be rewritten in place; I recorded the new information as a linked note instead.'
        : gone
          ? 'That memory no longer exists; I recorded the new information as a note instead.'
          : 'That memory cannot be updated under the current policy; I recorded the new information as a linked note instead.';
      const note = await this.kernel.encodeChunk(
        { content, kind: 'percept', source: 'user', priority: 'user' },
        { pluginId: 'session', sessionId: this.id },
      );
      // "Linked" has to mean an actual association, not just a new row.
      if (note && note.id !== nodeId) {
        await this.kernel.store.addEdge(note.id, { to: nodeId, type: 'similar', weight: 1 });
        await this.kernel.store.addEdge(nodeId, { to: note.id, type: 'similar', weight: 1 });
      }
      return { ok: false, message };
    }
  }

  private remember(userText: string, assistantText: string): void {    this.conversation.push({ role: 'user', content: userText });
    this.conversation.push({ role: 'assistant', content: assistantText });
    const maxMessages = this.kernel.config.maxConversationTurns * 2;
    if (this.conversation.length > maxMessages) {
      this.conversation.splice(0, this.conversation.length - maxMessages);
    }
  }

  /** Session end: residuals encode; optionally run a dream cycle. */
  async end(): Promise<SessionEndResult> {
    let encoded = 0;
    for (const chunk of this.wm.drain()) {
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
    // Defense in depth: a poisoned or corrupted procedural node's strategy
    // runs through the same per-turn tool-call budget as explicit calls.
    const cap = this.kernel.config.maxToolCallsPerTurn;
    let ok = true;
    for (const stepDef of steps.slice(0, cap)) {
      const exec = await this.kernel.executeTool(
        { name: stepDef.tool, args: stepDef.args },
        { pluginId: 'skill', sessionId: this.id },
      );
      traceSteps.push({ tool: stepDef.tool, args: stepDef.args });
      result.steps.push({ tool: stepDef.tool, args: stepDef.args });
      result.toolResults.push(exec.ok ? exec.result : `error: ${exec.error}`);
      const evicted = this.wm.attend({
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
