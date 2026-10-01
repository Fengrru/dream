import type {
  Association,
  DreamReport,
  EvidencePriority,
  Journal,
  MemoryNode,
  MemoryStore,
  TaskTrace,
  TraceStore,
} from './types';
import type { EmbeddingProvider } from './embeddings';
import { clamp, newId, sha256Hex } from './ids';
import { NotFoundError, ReconsolidationWindowClosedError } from './errors';
import { mineSkillBindings } from './skills';

export interface LifecycleConfig {
  /** How long a recalled memory stays writable (reconsolidation window). */
  reconsolidationWindowMs: number;
  /** Decay time-constant for a memory with importance 1, ms. */
  decayTauBaseMs: number;
  /** Strength below which a memory is considered faded (soft-forgotten). */
  forgetFloor: number;
  /** Cosine above which two episodes are merged during consolidation. */
  mergeThreshold: number;
  /** Minimum cluster size to abstract a semantic pattern from episodes. */
  abstractionMinCluster: number;
  /** Cosine threshold for clustering related episodes. */
  abstractionLinkThreshold: number;
  /** Minimum successful executions before a skill is induced. */
  skillMinSuccessfulEpisodes: number;
  /** Minimum success rate for skill induction. */
  skillMinSuccessRate: number;
  /**
   * Dream replay counts as retrieval practice: episodes with importance at or
   * above `replayStrengthensThreshold` are re-strengthened each cycle.
   * Experiment E3 showed critical memories otherwise decay to unrecoverable
   * within months — replay is the only mechanism that keeps them alive.
   */
  replayStrengthens: boolean;
  /** Importance floor for replay-strengthened episodes. */
  replayStrengthensThreshold: number;
}

export const DEFAULT_LIFECYCLE_CONFIG: LifecycleConfig = {
  // 90d: calibrated by experiment E3 — untouched critical memories survive
  // 180 days while noise still fades to zero. (30d works only with
  // replayStrengthens enabled.)
  reconsolidationWindowMs: 10 * 60 * 1000,
  decayTauBaseMs: 90 * 24 * 60 * 60 * 1000,
  forgetFloor: 0.05,
  mergeThreshold: 0.92,
  abstractionMinCluster: 3,
  abstractionLinkThreshold: 0.55,
  skillMinSuccessfulEpisodes: 3,
  skillMinSuccessRate: 0.6,
  replayStrengthens: true,
  replayStrengthensThreshold: 0.7,
};

const PRIORITY_RANK: Record<EvidencePriority, number> = {
  inference: 1,
  evidence: 2,
  user: 3,
};

export interface Abstraction {
  label: string;
  summary: string;
}

export interface AbstractionStrategy {
  abstract(cluster: MemoryNode[]): Promise<Abstraction>;
}

/**
 * Label a cluster of related episodes with its most discriminative shared
 * terms. Deterministic stand-in for an LLM abstraction pass.
 */
export class HeuristicAbstraction implements AbstractionStrategy {
  async abstract(cluster: MemoryNode[]): Promise<Abstraction> {
    const counts = new Map<string, number>();
    for (const node of cluster) {
      const terms = new Set((node.content.toLowerCase().match(/[a-z0-9']+/g) ?? []));
      for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1);
    }
    const stop = new Set(['the', 'a', 'an', 'is', 'was', 'i', 'my', 'me', 'to', 'of', 'and', 'in', 'it', 'that', 'this', 'for', 'on', 'with', 'at']);
    const ranked = [...counts.entries()]
      .filter(([term, n]) => n >= 2 && !stop.has(term) && term.length > 2)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 6)
      .map(([term]) => term);
    const label = ranked.length > 0 ? ranked.join(', ') : cluster[0]!.content.slice(0, 40);
    return {
      label,
      summary: `Recurring pattern across ${cluster.length} episodes.`,
    };
  }
}

export interface UpdateInput {
  content?: string;
  priority: EvidencePriority;
  reason: string;
}

/**
 * The memory lifecycle engine — the part that turns a vector store into a
 * memory system. It implements the biological loop:
 *
 *   encode -> consolidate ("dream") -> retrieve -> reconsolidate -> forget
 *
 * Forgetting is a function, not a bug: strength decays, retrieval practice
 * strengthens, and consolidation abstracts, merges and induces skills.
 */
export class LifecycleEngine {
  constructor(
    private readonly store: MemoryStore,
    private readonly traces: TraceStore,
    private readonly journal: Journal,
    private readonly provider: EmbeddingProvider,
    private readonly config: LifecycleConfig = DEFAULT_LIFECYCLE_CONFIG,
    private readonly now: () => number = Date.now,
    private readonly abstraction: AbstractionStrategy = new HeuristicAbstraction(),
  ) {}

  /** Retrieval practice: accessed memories strengthen and become writable. */
  async onRecalled(nodeIds: string[]): Promise<number> {
    const t = this.now();
    let touched = 0;
    for (const id of nodeIds) {
      const node = await this.store.getNode(id);
      if (!node) continue;
      node.strength = clamp(node.strength + 0.05 + 0.1 * node.importance, 0, 1);
      node.lastAccessedAt = t;
      node.labileUntil = t + this.config.reconsolidationWindowMs;
      await this.store.putNode(node);
      await this.journal.append({
        ts: t,
        type: 'recall',
        nodeId: node.id,
        version: node.version,
        contentHash: sha256Hex(node.content),
      });
      touched++;
    }
    return touched;
  }

  /**
   * Reconsolidation: rewrite a recently recalled memory. Conflicts resolve by
   * evidence priority (user > evidence > inference); lower-priority updates
   * are appended as counterpoints instead of overwriting.
   */
  async applyUpdate(nodeId: string, update: UpdateInput): Promise<MemoryNode> {
    const node = await this.store.getNode(nodeId);
    if (!node) throw new NotFoundError(nodeId);
    const t = this.now();
    if (node.labileUntil === undefined || t > node.labileUntil) {
      throw new ReconsolidationWindowClosedError(nodeId);
    }

    if (update.content !== undefined) {
      // Base priority derives from provenance (user statements outrank tool
      // outputs, which outrank model inference); later updates must beat it.
      const basePriority: EvidencePriority =
        node.provenance.source === 'user' ? 'user' : node.provenance.source === 'tool' ? 'evidence' : 'inference';
      const lastPriority = (node.meta?.['lastPriority'] as EvidencePriority | undefined) ?? basePriority;
      if (PRIORITY_RANK[update.priority] >= PRIORITY_RANK[lastPriority]) {
        node.content = update.content;
        const embedding = (await this.provider.embed([node.content]))[0]!;
        node.embedding = embedding;
        node.meta = { ...(node.meta ?? {}), lastPriority: update.priority };
      } else {
        node.content = `${node.content} — conflicting note kept: ${update.content}`;
      }
    }

    node.version += 1;
    node.strength = clamp(node.strength + 0.1, 0, 1);
    node.lastAccessedAt = t;
    node.labileUntil = t + this.config.reconsolidationWindowMs;
    await this.store.putNode(node);
    await this.journal.append({
      ts: t,
      type: 'update',
      nodeId: node.id,
      version: node.version,
      contentHash: sha256Hex(node.content),
      meta: { reason: update.reason, priority: update.priority },
    });
    return node;
  }

  /** Hard deletion for compliance: the node disappears, the journal keeps a tombstone. */
  async hardForget(nodeId: string, reason: string): Promise<boolean> {
    const node = await this.store.getNode(nodeId);
    if (!node) return false;
    await this.journal.append({
      ts: this.now(),
      type: 'purge',
      nodeId,
      version: node.version,
      contentHash: sha256Hex(node.content), // tombstone: hash only, body gone
      meta: { reason },
    });
    return this.store.deleteNode(nodeId);
  }

  /** Adaptive forgetting: retrievability decays; importance buys resistance. */
  async decayPass(): Promise<{ decayed: number; faded: number }> {
    const t = this.now();
    const nodes = await this.store.listNodes();
    let decayed = 0;
    let faded = 0;
    for (const node of nodes) {
      const dt = t - node.lastAccessedAt;
      if (dt <= 0) continue;
      // Importance buys resistance: higher-importance memories decay slower.
      const tau = this.config.decayTauBaseMs * clamp(node.importance, 0.1, 1);
      const next = node.strength * Math.exp(-dt / tau);
      if (next === node.strength) continue;
      node.strength = next;
      // Advance the decay reference: each pass covers only the elapsed slice.
      // (Experiment E3's tau sweep caught the missing line below — without it
      // every pass re-decayed the full history, compounding quadratically.)
      node.lastAccessedAt = t;
      await this.store.putNode(node);
      decayed++;
      if (next < this.config.forgetFloor) faded++;
    }
    await this.journal.append({
      ts: t,
      type: 'decay',
      meta: { decayed, faded },
    });
    return { decayed, faded };
  }

  /**
   * The dream cycle: offline consolidation, run when the agent is idle.
   * Replay unconsolidated episodes -> cluster -> abstract semantic patterns ->
   * merge near-duplicates -> induce/refresh skills from task traces -> decay.
   */
  async dream(): Promise<DreamReport> {
    const startedAt = this.now();
    const report: DreamReport = {
      startedAt,
      finishedAt: startedAt,
      replayedEpisodes: 0,
      abstractions: [],
      mergedCount: 0,
      skillsFormed: [],
      skillsUpdated: [],
      selfUpdates: [],
      fadedCount: 0,
      notes: [],
    };

    const episodes = (await this.store.listNodes({ kinds: ['episodic'], excludeQuarantined: true }))
      .filter((n) => n.consolidatedAt === undefined);
    report.replayedEpisodes = episodes.length;

    // 1. Cluster related episodes (pairwise similarity + existing similar edges).
    const clusters = await this.clusterEpisodes(episodes);

    // 2. Abstract semantic patterns from sufficiently large clusters.
    for (const cluster of clusters) {
      if (cluster.length < this.config.abstractionMinCluster) continue;
      const abstraction = await this.abstraction.abstract(cluster);
      // Centroid embedding: the abstraction occupies the semantic center of
      // its cluster, so pattern-level queries land on it in the same space as
      // the episodes it summarizes (experiment E2).
      const centroid = new Array<number>(cluster[0]!.embedding.length).fill(0);
      for (const member of cluster) {
        for (let i = 0; i < centroid.length; i++) centroid[i] = centroid[i]! + (member.embedding[i] ?? 0);
      }
      let norm = 0;
      for (let i = 0; i < centroid.length; i++) {
        centroid[i] = centroid[i]! / cluster.length;
        norm += centroid[i]! * centroid[i]!;
      }
      norm = Math.sqrt(norm);
      const embedding = norm > 0 ? centroid.map((v) => v / norm) : (await this.provider.embed([abstraction.label]))[0]!;
      const avgImportance = cluster.reduce((s, n) => s + n.importance, 0) / cluster.length;
      const node: MemoryNode = {
        id: newId('mem'),
        kind: 'semantic',
        scope: 'user',
        content: `Pattern: ${abstraction.label}. ${abstraction.summary}`,
        embedding,
        edges: [],
        provenance: { source: 'dream', trust: 0.7 },
        importance: clamp(avgImportance + 0.1, 0, 0.9),
        strength: 1,
        createdAt: this.now(),
        lastAccessedAt: this.now(),
        version: 1,
        meta: { abstractedFrom: cluster.map((n) => n.id) },
      };
      await this.store.putNode(node);
      for (const member of cluster) {
        await this.store.addEdge(node.id, { to: member.id, type: 'similar', weight: 0.8 });
        await this.store.addEdge(member.id, { to: node.id, type: 'similar', weight: 0.8 });
      }
      await this.journal.append({
        ts: this.now(),
        type: 'abstract',
        nodeId: node.id,
        version: 1,
        contentHash: sha256Hex(node.content),
        meta: { clusterSize: cluster.length, label: abstraction.label },
      });
      report.abstractions.push(abstraction.label);
    }

    // 3. Merge near-duplicate episodes.
    for (let i = 0; i < episodes.length; i++) {
      const a = episodes[i]!;
      for (let j = i + 1; j < episodes.length; j++) {
        const b = episodes[j]!;
        if (a.consolidatedAt !== undefined && b.consolidatedAt !== undefined) continue;
        const sim = this.similarity(a, b);
        if (sim < this.config.mergeThreshold) continue;
        const rep = a.importance >= b.importance ? a : b;
        const other = rep === a ? b : a;
        other.strength *= 0.5;
        other.consolidatedAt = this.now();
        await this.store.addEdge(other.id, { to: rep.id, type: 'similar', weight: sim });
        await this.store.putNode(other);
        report.mergedCount++;
      }
    }

    // 4. Procedural induction from task traces.
    const skillResult = await this.induceSkills();
    report.skillsFormed = skillResult.formed;
    report.skillsUpdated = skillResult.updated;

    // 5. Mark processed episodes as consolidated, then decay everything.
    for (const episode of episodes) {
      if (episode.consolidatedAt !== undefined) continue;
      episode.consolidatedAt = this.now();
      await this.store.putNode(episode);
    }

    // Replay strengthens: consolidation replay counts as retrieval practice
    // for important memories (E3: without this, even critical facts decay to
    // unrecoverable within months). Runs before the decay pass so the boost
    // lands on a fresh lastAccessedAt.
    if (this.config.replayStrengthens) {
      const replayWorthy = episodes
        .filter((e) => e.importance >= this.config.replayStrengthensThreshold)
        .map((e) => e.id);
      if (replayWorthy.length > 0) await this.onRecalled(replayWorthy);
    }

    const decay = await this.decayPass();
    report.fadedCount = decay.faded;

    report.finishedAt = this.now();
    return report;
  }

  private similarity(a: MemoryNode, b: MemoryNode): number {
    let dot = 0;
    for (let i = 0; i < a.embedding.length; i++) dot += a.embedding[i]! * (b.embedding[i] ?? 0);
    return dot; // embeddings are L2-normalized
  }

  private async clusterEpisodes(episodes: MemoryNode[]): Promise<MemoryNode[][]> {
    const parent = new Map<string, string>(episodes.map((e) => [e.id, e.id] as const));
    const find = (x: string): string => {
      let root = x;
      while (parent.get(root) !== root) root = parent.get(root)!;
      return root;
    };
    const union = (x: string, y: string) => {
      parent.set(find(x), find(y));
    };

    const edgeLinked = new Set<string>();
    for (const ep of episodes) {
      const edges: Association[] = await this.store.getEdges(ep.id, 'similar');
      for (const edge of edges) {
        if (parent.has(edge.to)) {
          union(ep.id, edge.to);
          edgeLinked.add(`${ep.id}|${edge.to}`);
        }
      }
    }
    for (let i = 0; i < episodes.length; i++) {
      for (let j = i + 1; j < episodes.length; j++) {
        const a = episodes[i]!;
        const b = episodes[j]!;
        const key = `${a.id}|${b.id}`;
        if (edgeLinked.has(key) || edgeLinked.has(`${b.id}|${a.id}`)) continue;
        if (this.similarity(a, b) >= this.config.abstractionLinkThreshold) union(a.id, b.id);
      }
    }

    const groups = new Map<string, MemoryNode[]>();
    for (const ep of episodes) {
      const root = find(ep.id);
      const group = groups.get(root) ?? [];
      group.push(ep);
      groups.set(root, group);
    }
    return [...groups.values()];
  }

  private async induceSkills(): Promise<{ formed: string[]; updated: string[] }> {
    const formed: string[] = [];
    const updated: string[] = [];
    const traces = await this.traces.listTraces();

    const byType = new Map<string, TaskTrace[]>();
    for (const trace of traces) {
      const list = byType.get(trace.taskType) ?? [];
      list.push(trace);
      byType.set(trace.taskType, list);
    }

    const existingSkills = await this.store.listNodes({ kinds: ['procedural'] });

    for (const [taskType, group] of byType) {
      const successes = group.filter((t) => t.outcome === 'success');
      if (successes.length < this.config.skillMinSuccessfulEpisodes) continue;
      const successRate = successes.length / group.length;
      if (successRate < this.config.skillMinSuccessRate) continue;

      // Canonical strategy: the most frequent successful step sequence.
      const seqCounts = new Map<string, { steps: TaskTrace['steps']; count: number }>();
      for (const trace of successes) {
        const key = JSON.stringify(trace.steps);
        const entry = seqCounts.get(key);
        if (entry) entry.count++;
        else seqCounts.set(key, { steps: trace.steps, count: 1 });
      }
      let best: { steps: TaskTrace['steps']; count: number } | undefined;
      for (const entry of seqCounts.values()) {
        if (!best || entry.count > best.count) best = entry;
      }
      if (!best) continue;

      const existing = existingSkills.find((n) => n.meta?.['taskType'] === taskType);
      const binding = mineSkillBindings(successes, best.steps);
      if (existing) {
        const prevRate = (existing.meta?.['successRate'] as number | undefined) ?? successRate;
        existing.meta = {
          ...(existing.meta ?? {}),
          strategy: { steps: best.steps },
          binding,
          successRate: 0.5 * prevRate + 0.5 * successRate,
        };
        existing.version += 1;
        existing.strength = clamp(existing.strength + 0.1, 0, 1);
        await this.store.putNode(existing);
        await this.journal.append({
          ts: this.now(),
          type: 'skill',
          nodeId: existing.id,
          version: existing.version,
          meta: { taskType, successRate },
        });
        updated.push(taskType);
      } else {
        const content = `Skill: ${taskType}`;
        const embedding = (await this.provider.embed([content]))[0]!;
        const node: MemoryNode = {
          id: newId('skill'),
          kind: 'procedural',
          scope: 'agent',
          content,
          embedding,
          edges: [],
          provenance: { source: 'dream', trust: 0.8 },
          importance: 0.7,
          strength: 1,
          createdAt: this.now(),
          lastAccessedAt: this.now(),
          version: 1,
          meta: {
            taskType,
            strategy: { steps: best.steps },
            binding,
            successRate,
          },
        };
        await this.store.putNode(node);
        await this.journal.append({
          ts: this.now(),
          type: 'skill',
          nodeId: node.id,
          version: 1,
          meta: { taskType, successRate, formed: true },
        });
        formed.push(taskType);
      }
    }
    return { formed, updated };
  }
}
