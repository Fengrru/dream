import type {
  Association,
  DreamReport,
  EvidencePriority,
  Journal,
  MemoryNode,
  MemoryStore,
  ProvenanceSource,
  TaskTrace,
  TraceStore,
} from './types';
import type { EmbeddingProvider } from './embeddings';
import { clamp, newId, sha256Hex } from './ids';
import {
  NotFoundError,
  ReconsolidationWindowClosedError,
  SupersededMemoryError,
} from './errors';
import { mineSkillBindings } from './skills';
import { lexicalTokens } from './lexical';

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

const SKILL_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'with', 'is', 'was',
  'run', 'please', 'again', 'this', 'that', 'my', 'me', 'i', 'it', 'do', 'does',
]);

/**
 * Mine retrieval keys for a skill from the percepts that produced it. Keys are
 * what a future request is matched against when no explicit task type is sent;
 * the label alone ("Skill: analyze-data") is often too thin.
 */
function mineSkillSearchKeys(successes: TaskTrace[], taskType: string): string[] {
  const counts = new Map<string, number>();
  for (const trace of successes) {
    if (!trace.percept) continue;
    const seen = new Set(
      lexicalTokens(trace.percept).filter(
        (token) =>
          !token.startsWith('zhb:') &&
          token.length >= 2 &&
          !SKILL_STOPWORDS.has(token),
      ),
    );
    for (const token of seen) counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  const ranked = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 6)
    .map(([token]) => token);
  return [...new Set([taskType, ...ranked])];
}

function skillBoundaries(successes: TaskTrace[]): string[] {
  const envs = new Set<string>();
  for (const trace of successes) {
    const env = trace.environment?.trim();
    if (env) envs.add(env);
  }
  return [...envs].sort();
}

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
  /** Session that produced the correction (provenance only, never an isolation key). */
  sessionId?: string;
}

export interface EvolutionResult {
  /** The authoritative record after the operation (new version, or the old one if a counterpoint was appended). */
  node: MemoryNode;
  /** The previous version, present only when a new version was created. */
  previous?: MemoryNode;
  /** True when the old record was retired and a new latest version now exists. */
  superseded: boolean;
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
   * Evidence accumulation: another observation supports an existing record.
   * Confidence moves toward the new observation; evidence count is monotonic.
   */
  async reinforceMemory(
    nodeId: string,
    input: { confidence?: number; evidenceDelta?: number; reason?: string } = {},
  ): Promise<MemoryNode> {
    const node = await this.store.getNode(nodeId);
    if (!node) throw new NotFoundError(nodeId);
    const t = this.now();
    const delta = Math.max(1, Math.round(input.evidenceDelta ?? 1));
    node.evidenceCount = (node.evidenceCount ?? 1) + delta;
    if (input.confidence !== undefined) {
      const previous = node.confidence ?? 1;
      node.confidence = clamp(0.7 * previous + 0.3 * input.confidence, 0, 1);
    } else {
      node.confidence = clamp((node.confidence ?? 1) + 0.05 * delta, 0, 1);
    }
    node.strength = clamp(node.strength + 0.05, 0, 1);
    node.lastAccessedAt = t;
    await this.store.putNode(node);
    await this.journal.append({
      ts: t,
      type: 'update',
      nodeId,
      version: node.version,
      contentHash: sha256Hex(node.content),
      meta: {
        action: 'reinforce',
        evidenceCount: node.evidenceCount,
        confidence: node.confidence,
        reason: input.reason ?? 'evidence',
      },
    });
    return node;
  }

  /**
   * TriLink: link a fact to the experience it produced (and back). Facts stay
   * the evidence layer; experiences point at the task facts that justify them.
   */
  async linkFactToExperience(
    factId: string,
    experienceId: string,
  ): Promise<{ fact: MemoryNode; experience: MemoryNode }> {
    const fact = await this.store.getNode(factId);
    if (!fact) throw new NotFoundError(factId);
    const experience = await this.store.getNode(experienceId);
    if (!experience) throw new NotFoundError(experienceId);
    const t = this.now();

    const derived = new Set((fact.meta?.['derivedExperienceIds'] as string[] | undefined) ?? []);
    derived.add(experienceId);
    fact.meta = { ...(fact.meta ?? {}), derivedExperienceIds: [...derived] };
    await this.store.putNode(fact);

    const sources = new Set((experience.meta?.['sourceFactIds'] as string[] | undefined) ?? []);
    sources.add(factId);
    experience.meta = { ...(experience.meta ?? {}), sourceFactIds: [...sources] };
    await this.store.putNode(experience);

    await this.journal.append({
      ts: t,
      type: 'update',
      nodeId: factId,
      version: fact.version,
      contentHash: sha256Hex(fact.content),
      meta: { action: 'tri-link', experienceId },
    });
    return { fact, experience };
  }

  private async backfillExperienceLinks(
    experienceId: string,
    factIds: string[],
  ): Promise<void> {
    for (const factId of new Set(factIds)) {
      const fact = await this.store.getNode(factId);
      if (!fact) continue;
      const derived = new Set(
        (fact.meta?.['derivedExperienceIds'] as string[] | undefined) ?? [],
      );
      if (derived.has(experienceId)) continue;
      derived.add(experienceId);
      fact.meta = { ...(fact.meta ?? {}), derivedExperienceIds: [...derived] };
      await this.store.putNode(fact);
    }
  }

  /**
   * Reconsolidation: rewrite a recently recalled memory. Conflicts resolve by
   * evidence priority (user > evidence > inference); lower-priority updates
   * are appended as counterpoints instead of overwriting.
   */
  async applyUpdate(nodeId: string, update: UpdateInput): Promise<MemoryNode> {
    const node = await this.store.getNode(nodeId);
    if (!node) throw new NotFoundError(nodeId);
    if (node.isLatest === false) {
      throw new SupersededMemoryError(node.id, node.supersededBy ?? 'unknown');
    }
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
      const previousContent = node.content;
      const previousVersion = node.version;
      const history = Array.isArray(node.meta?.['versionHistory'])
        ? ([...(node.meta!['versionHistory'] as Array<Record<string, unknown>>)])
        : [];
      history.push({
        content: previousContent,
        version: previousVersion,
        replacedAt: t,
        reason: update.reason,
        priority: update.priority,
      });
      const versionHistory = history.slice(-10);
      if (PRIORITY_RANK[update.priority] >= PRIORITY_RANK[lastPriority]) {
        node.content = update.content;
        const embedding = (await this.provider.embed([node.content]))[0]!;
        node.embedding = embedding;
        node.meta = { ...(node.meta ?? {}), lastPriority: update.priority, versionHistory };
      } else {
        node.content = `${node.content} — conflicting note kept: ${update.content}`;
        // The rewrite was refused, but the attempt is still auditable.
        node.meta = { ...(node.meta ?? {}), versionHistory };
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

  /**
   * Version-chain evolution (post-window correction).
   *
   * Once the reconsolidation window has closed, history must not be rewritten
   * in place. Instead of rejecting the correction and leaving a detached note
   * that competes with the stale fact, this creates a NEW latest version and
   * retires the old one (`isLatest: false`, `supersededBy`). Current recall
   * only sees the latest version; the full ancestry stays inspectable through
   * `versionChain`. Evidence priority still applies: a lower-priority claim is
   * appended to the current version as a counterpoint instead of superseding it.
   */
  async supersedeMemory(nodeId: string, update: UpdateInput): Promise<EvolutionResult> {
    const previous = await this.store.getNode(nodeId);
    if (!previous) throw new NotFoundError(nodeId);
    if (previous.isLatest === false) {
      throw new SupersededMemoryError(previous.id, previous.supersededBy ?? 'unknown');
    }
    if (update.content === undefined) {
      throw new Error('supersedeMemory requires new content');
    }

    const t = this.now();
    const basePriority: EvidencePriority =
      previous.provenance.source === 'user'
        ? 'user'
        : previous.provenance.source === 'tool'
          ? 'evidence'
          : 'inference';
    const lastPriority =
      (previous.meta?.['lastPriority'] as EvidencePriority | undefined) ?? basePriority;

    if (PRIORITY_RANK[update.priority] < PRIORITY_RANK[lastPriority]) {
      // A weaker source cannot retire a stronger claim, even outside the
      // window: keep the current version authoritative and record a counterpoint.
      previous.content = `${previous.content} — conflicting note kept: ${update.content}`;
      previous.embedding = (await this.provider.embed([previous.content]))[0]!;
      previous.version += 1;
      previous.strength = clamp(previous.strength + 0.1, 0, 1);
      previous.lastAccessedAt = t;
      previous.meta = { ...(previous.meta ?? {}), lastPriority: update.priority };
      await this.store.putNode(previous);
      await this.journal.append({
        ts: t,
        type: 'update',
        nodeId: previous.id,
        version: previous.version,
        contentHash: sha256Hex(previous.content),
        meta: { action: 'counterpoint', reason: update.reason, priority: update.priority },
      });
      return { node: previous, superseded: false };
    }

    const embedding = (await this.provider.embed([update.content]))[0]!;
    const source: ProvenanceSource =
      update.priority === 'user' ? 'user' : update.priority === 'evidence' ? 'tool' : 'inference';
    const lineage = [
      ...((previous.meta?.['lineage'] as string[] | undefined) ?? []),
      previous.id,
    ];
    const latest: MemoryNode = {
      id: newId('mem'),
      kind: previous.kind,
      scope: previous.scope,
      content: update.content,
      embedding,
      // Inherit the old version's associations so the current version keeps
      // the same position in the graph (spreading activation still reaches it).
      edges: previous.edges.filter((e) => e.to !== previous.id).map((e) => ({ ...e })),
      provenance: {
        source,
        sessionId: update.sessionId,
        trust: source === 'user' ? 1 : source === 'tool' ? 0.9 : 0.7,
      },
      importance: clamp(previous.importance + 0.05, 0, 1),
      strength: 1,
      createdAt: t,
      lastAccessedAt: t,
      labileUntil: t + this.config.reconsolidationWindowMs,
      version: previous.version + 1,
      isLatest: true,
      supersedes: [previous.id],
      meta: {
        ...(previous.meta ?? {}),
        lastPriority: update.priority,
        supersededReason: update.reason,
        lineage,
      },
    };

    previous.isLatest = false;
    previous.supersededBy = latest.id;
    previous.meta = { ...(previous.meta ?? {}), supersededAt: t };
    await this.store.putNode(previous);
    await this.store.putNode(latest);
    await this.store.addEdge(latest.id, { to: previous.id, type: 'version', weight: 1 });
    await this.store.addEdge(previous.id, { to: latest.id, type: 'version', weight: 1 });
    for (const edge of latest.edges) {
      await this.store.addEdge(edge.to, { to: latest.id, type: edge.type, weight: edge.weight });
    }

    await this.journal.append({
      ts: t,
      type: 'update',
      nodeId: previous.id,
      version: previous.version,
      contentHash: sha256Hex(previous.content),
      meta: { action: 'supersede', supersededBy: latest.id, reason: update.reason, priority: update.priority },
    });
    await this.journal.append({
      ts: t,
      type: 'encode',
      nodeId: latest.id,
      version: latest.version,
      contentHash: sha256Hex(latest.content),
      meta: { supersedes: previous.id, kind: latest.kind, importance: latest.importance },
    });

    return { node: latest, previous, superseded: true };
  }

  /**
   * Full version chain for a record, oldest -> newest. Walks `supersedes` back
   * to the root and `supersededBy` forward to the current version.
   */
  async versionChain(nodeId: string): Promise<MemoryNode[]> {
    let cursor = await this.store.getNode(nodeId);
    if (!cursor) throw new NotFoundError(nodeId);

    const seen = new Set<string>([cursor.id]);
    let guard = 0;
    while (cursor.supersedes?.length && guard++ < 1000) {
      const parentId = cursor.supersedes[cursor.supersedes.length - 1]!;
      if (seen.has(parentId)) break;
      const parent = await this.store.getNode(parentId);
      if (!parent) break;
      seen.add(parent.id);
      cursor = parent;
    }

    const chain: MemoryNode[] = [cursor];
    guard = 0;
    while (cursor.supersededBy && guard++ < 1000) {
      const nextId = cursor.supersededBy;
      if (chain.some((n) => n.id === nextId)) break;
      const next = await this.store.getNode(nextId);
      if (!next) break;
      chain.push(next);
      cursor = next;
    }
    return chain;
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
  /**
   * Expire prospective intentions. An expired intention is demoted to an
   * ordinary semantic fact (Hy-Memory's L7 rule): it stops being a proactive
   * cue but is not forgotten.
   */
  async expireIntentions(): Promise<number> {
    const t = this.now();
    const nodes = await this.store.listNodes({ kinds: ['semantic'] });
    let expired = 0;
    for (const node of nodes) {
      if (node.meta?.['intention'] !== true) continue;
      const expiresAt = node.meta?.['expiresAt'];
      if (typeof expiresAt !== 'number' || expiresAt > t) continue;
      node.meta = { ...(node.meta ?? {}), intention: false, expiredAt: t };
      await this.store.putNode(node);
      await this.journal.append({
        ts: t,
        type: 'update',
        nodeId: node.id,
        version: node.version,
        contentHash: sha256Hex(node.content),
        meta: { action: 'expire-intention' },
      });
      expired++;
    }
    return expired;
  }

  async dream(): Promise<DreamReport> {
    const startedAt = this.now();
    const expiredIntentions = await this.expireIntentions();
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
      notes:
        expiredIntentions > 0
          ? [`${expiredIntentions} expired intention(s) demoted to ordinary facts`]
          : [],
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
      const searchKeys = mineSkillSearchKeys(successes, taskType);
      const boundaryEnvs = skillBoundaries(successes);
      const confidence = clamp(successRate * Math.min(1, successes.length / 5), 0, 1);
      const sourceTraceIds = successes.slice(-20).map((trace) => trace.id);
      const sourceFactIds = [...new Set(successes.flatMap((trace) => trace.factIds ?? []))];
      if (existing) {
        const prevRate = (existing.meta?.['successRate'] as number | undefined) ?? successRate;
        existing.meta = {
          ...(existing.meta ?? {}),
          strategy: { steps: best.steps },
          binding,
          successRate: 0.5 * prevRate + 0.5 * successRate,
          searchKeys,
          boundaryEnvs,
          confidence,
          sourceTraceIds,
          sourceFactIds,
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
        await this.backfillExperienceLinks(existing.id, sourceFactIds);
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
            searchKeys,
            boundaryEnvs,
            confidence,
            sourceTraceIds,
            sourceFactIds,
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
        await this.backfillExperienceLinks(node.id, sourceFactIds);
        formed.push(taskType);
      }
    }
    return { formed, updated };
  }
}
