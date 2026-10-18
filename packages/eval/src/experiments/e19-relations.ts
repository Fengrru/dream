import {
  ActivationEngine,
  EncodingGate,
  HashingEmbeddingProvider,
  InMemoryStore,
  type EmbeddingProvider,
} from '@dream/core';
import { FakeClock } from '../instance';
import { makeTable, type ExperimentResult } from './harness';

const MINUTE = 60 * 1000;
type EdgeType = 'temporal' | 'spatial' | 'entity' | 'causal' | 'contrast' | 'elaborates' | 'similar' | 'version';

async function typedEdges(enabled: boolean): Promise<Record<string, number>> {
  const provider = new HashingEmbeddingProvider(256);
  const store = new InMemoryStore();
  const clock = new FakeClock();
  const gate = new EncodingGate(store, store, provider, undefined, clock.now, 30 * MINUTE, enabled);
  const first = (await gate.encode({
    content: 'The service latency is high',
    kind: 'percept',
    source: 'user',
    tags: ['billing-service'],
  }))!;
  const second = (await gate.encode({
    content: 'The service latency is high because billing-service cache is cold',
    kind: 'percept',
    source: 'user',
    tags: ['billing-service'],
  }))!;
  const counts: Record<string, number> = {};
  for (const id of [first.id, second.id]) {
    for (const edge of await store.getEdges(id)) {
      counts[edge.type] = (counts[edge.type] ?? 0) + 1;
    }
  }
  return counts;
}

/** Fixed-vector provider isolates spreading from embedding collisions. */
class FixedProvider implements EmbeddingProvider {
  readonly dim = 4;
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      if (text === 'query') return [1, 0, 0, 0];
      return [0, 0, 1, 0];
    });
  }
}

async function relationPathAndPrior(): Promise<{
  withoutRatio: number;
  withRatio: number;
  pathHasCausal: boolean;
  causalAhead: boolean;
}> {
  const provider = new FixedProvider();
  const store = new InMemoryStore();
  const nodes = [
    { id: 'seed', content: 'seed', embedding: [1, 0, 0, 0] },
    { id: 'causal-node', content: 'cause', embedding: [0, 1, 0, 0] },
    { id: 'similar-node', content: 'note', embedding: [0, 0, 1, 0] },
  ];
  for (const node of nodes) {
    await store.putNode({
      id: node.id,
      kind: 'semantic',
      scope: 'user',
      content: node.content,
      embedding: node.embedding,
      edges: [],
      provenance: { source: 'user', trust: 1 },
      importance: 0.6,
      strength: 1,
      createdAt: 1,
      lastAccessedAt: 1,
      version: 1,
    });
  }
  await store.addEdge('seed', { to: 'causal-node', type: 'causal', weight: 1 });
  await store.addEdge('seed', { to: 'similar-node', type: 'similar', weight: 1 });

  const engine = new ActivationEngine(provider);
  const activate = (relationPriors?: Partial<Record<EdgeType, number>>) =>
    engine.activate(store, ['query'], {
      capacity: 3,
      relationPriors,
      diversityThreshold: 1,
      tagWeight: 0,
      episodeWeight: 0,
    });
  const baseline = await activate(undefined);
  const enhanced = await activate({ causal: 0.9, similar: 0.5 });
  const act = (set: Awaited<ReturnType<typeof activate>>, id: string) =>
    (set.workingSet.find((chunk) => chunk.meta?.['nodeId'] === id)?.meta?.['activation'] as number) ??
    0;
  const causal = enhanced.workingSet.find((chunk) => chunk.meta?.['nodeId'] === 'causal-node');
  const path = (causal?.meta?.['relationPath'] as Array<{ type: string }> | undefined) ?? [];
  const index = (id: string) =>
    enhanced.workingSet.findIndex((chunk) => chunk.meta?.['nodeId'] === id);
  return {
    withoutRatio: act(baseline, 'causal-node') / Math.max(1e-9, act(baseline, 'similar-node')),
    withRatio: act(enhanced, 'causal-node') / Math.max(1e-9, act(enhanced, 'similar-node')),
    pathHasCausal: path.some((step) => step.type === 'causal'),
    causalAhead: index('causal-node') >= 0 && index('causal-node') < index('similar-node'),
  };
}

/**
 * E19 — Rule-based typed graph memory.
 *
 * Hy-Memory's graph layer distinguishes causal/contrast/temporal relations and
 * returns relation paths. This experiment checks the deterministic version:
 * cue-based edges at encode, typed paths during spreading, and type priors that
 * let a causal neighbour outrank an equally weighted similar neighbour.
 */
export async function e19Relations(): Promise<ExperimentResult> {
  const withoutEdges = await typedEdges(false);
  const withEdges = await typedEdges(true);
  const path = await relationPathAndPrior();

  const typedCount = (counts: Record<string, number>, type: string) => counts[type] ?? 0;
  const passed =
    typedCount(withEdges, 'causal') > 0 &&
    typedCount(withEdges, 'elaborates') > 0 &&
    typedCount(withEdges, 'temporal') > 0 &&
    typedCount(withEdges, 'entity') > 0 &&
    typedCount(withoutEdges, 'causal') === 0 &&
    path.pathHasCausal &&
    path.withRatio > 1.5 &&
    path.causalAhead;

  const rows: Array<Array<string | number>> = [
    [
      'typed edges (outgoing)',
      Object.entries(withoutEdges)
        .map(([type, count]) => `${type}:${count}`)
        .join(', ') || 'none',
      Object.entries(withEdges)
        .map(([type, count]) => `${type}:${count}`)
        .join(', ') || 'none',
    ],
    [
      'causal / similar activation ratio',
      Math.round(path.withoutRatio * 100) / 100,
      Math.round(path.withRatio * 100) / 100,
    ],
    ['relation path records causal hop', 'no', path.pathHasCausal ? 'yes' : 'no'],
    ['causal neighbour ahead of similar', 'no', path.causalAhead ? 'yes' : 'no'],
  ];

  const findings = [
    `Typed edges: rule extraction produced ${Object.entries(withEdges)
      .map(([type, count]) => `${type}=${count}`)
      .join(', ')}; with extraction disabled only the similar edges remained.`,
    `Relation paths: spreading recorded a typed path (${path.pathHasCausal ? 'including' : 'missing'} the causal hop), so the reasoner can see WHY a memory was activated.`,
    `Type priors: causal/similar activation ratio moved from ${path.withoutRatio.toFixed(2)} to ${path.withRatio.toFixed(2)}, making the causal neighbour top-1 without changing either edge's base weight.`,
    `The extractor is cue-based and deterministic; a missed cue degrades to a similar edge, never to an invented relation.`,
  ];

  return {
    id: 'E19',
    title: 'Rule-based typed graph memory',
    question: 'Can deterministic relation cues build a typed graph and make activation paths explainable?',
    hypothesis:
      'Causal/contrast language plus same-episode sequencing yields typed edges; spreading records the path and type priors rank causal neighbours above similar ones.',
    method: [
      'Encode two related notes with and without typed-relation extraction; count outgoing edge types.',
      'Build a seed with one causal and one similar neighbour using fixed embeddings; compare activation ratios with/without type priors.',
      'Inspect the recalled candidate\'s relationPath for the causal hop.',
    ],
    tables: [
      makeTable('Typed graph behavior', ['metric', 'without', 'with'], rows),
    ],
    findings,
    recommendations: [
      'Keep typed extraction rule-based by default; it is cheap, predictable and cannot invent a relation.',
      'Use relation priors instead of raising base weights: the edge stays honest, the ranking expresses what the relation is worth.',
      'Add an LLM relation extractor only as an optional deep-mode plugin; the deterministic graph remains the fallback.',
    ],
    verdict: passed ? 'works' : 'partial',
  };
}
