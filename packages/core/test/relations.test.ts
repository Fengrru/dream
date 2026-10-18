import { describe, expect, it } from 'vitest';
import { ActivationEngine } from '../src/activation';
import { relationCues } from '../src/relations';
import { buildCore } from './helpers';

describe('Rule-based relation cues', () => {
  it('detects causal and contrast language in English and Chinese', () => {
    expect(relationCues('The service is slow because the cache is cold').causal).toBe(true);
    expect(relationCues('We tried Redis, but the misses continued').contrast).toBe(true);
    expect(relationCues('缓存未命中，因此延迟升高').causal).toBe(true);
    expect(relationCues('方案 A 可行，然而成本太高').contrast).toBe(true);
    expect(relationCues('The deploy window is Friday').causal).toBe(false);
  });
});

describe('Encoding typed edges', () => {
  it('creates causal, temporal, elaborates and entity edges', async () => {
    const { gate, store } = buildCore();
    const first = (await gate.encode({
      content: 'The service latency is high',
      kind: 'percept',
      source: 'user',
      tags: ['billing-service'],
    }))!;
    const second = (await gate.encode({
      content: 'The service latency is high because the billing-service cache is cold',
      kind: 'percept',
      source: 'user',
      tags: ['billing-service'],
    }))!;

    const secondEdges = await store.getEdges(second.id);
    const types = secondEdges.map((edge) => edge.type);
    expect(types).toContain('causal');
    expect(types).toContain('elaborates');
    expect(types).toContain('temporal');
    const firstEdges = await store.getEdges(first.id);
    expect(firstEdges.map((edge) => edge.type)).toContain('entity');
  });

  it('creates contrast edges when the text signals a conflict', async () => {
    const { gate, store } = buildCore();
    await gate.encode({ content: 'Use Redis for the cache', kind: 'percept', source: 'user' });
    const contrast = (await gate.encode({
      content: 'We tried Redis, but the cache misses continued',
      kind: 'percept',
      source: 'user',
    }))!;
    const types = (await store.getEdges(contrast.id)).map((edge) => edge.type);
    expect(types).toContain('contrast');
  });
});

describe('Relation paths and type priors', () => {
  it('records a typed path and lets a causal edge outrank a similar edge', async () => {
    const { store, provider } = buildCore();
    const embed = async (content: string) => (await provider.embed([content]))[0]!;
    const make = async (id: string, content: string) => {
      await store.putNode({
        id,
        kind: 'semantic',
        scope: 'user',
        content,
        embedding: await embed(content),
        edges: [],
        provenance: { source: 'user', trust: 1 },
        importance: 0.6,
        strength: 1,
        createdAt: 1,
        lastAccessedAt: 1,
        version: 1,
      });
    };
    await make('seed', 'zzz incident marker');
    await make('causal-node', 'alpha cache cause');
    await make('similar-node', 'beta unrelated note');
    await store.addEdge('seed', { to: 'causal-node', type: 'causal', weight: 1 });
    await store.addEdge('seed', { to: 'similar-node', type: 'similar', weight: 1 });

    const engine = new ActivationEngine(provider);
    const set = await engine.activate(store, ['zzz incident marker'], {
      capacity: 4,
      relationPriors: { causal: 0.9, similar: 0.5 },
      degreeNormalize: false,
      diversityThreshold: 1,
      tagWeight: 0,
      episodeWeight: 0,
    });
    const causal = set.workingSet.find((chunk) => chunk.meta?.['nodeId'] === 'causal-node');
    const similar = set.workingSet.find((chunk) => chunk.meta?.['nodeId'] === 'similar-node');
    expect(causal).toBeDefined();
    expect(similar).toBeDefined();
    expect(causal!.meta?.['activation']).toBeGreaterThan(similar!.meta?.['activation'] as number);
    const path = causal!.meta?.['relationPath'] as Array<{ type: string }>;
    expect(path.map((step) => step.type)).toContain('causal');
  });
});
