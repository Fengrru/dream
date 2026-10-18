import { describe, expect, it } from 'vitest';
import { ActivationEngine } from '../src/activation';
import { extractEntityTags, matchingTags } from '../src/entities';
import { buildCore } from './helpers';

const MINUTE = 60 * 1000;

describe('Entity/tag channel', () => {
  it('extracts names, identifiers and quoted titles', () => {
    const tags = extractEntityTags('Project ZQ-4821 uses PostgreSQL; see 「星云7号」 and QF27.');
    expect(tags).toContain('ZQ-4821');
    expect(tags).toContain('PostgreSQL');
    expect(tags).toContain('星云7号');
    expect(tags).toContain('QF27');
    expect(matchingTags(tags, 'which project uses zq-4821?')).toEqual(['ZQ-4821']);
  });

  it('nominates a memory that only shares an explicit tag with the query', async () => {
    const { gate, store, provider } = buildCore();
    await gate.encode({
      content: 'Quarterly numbers improved by four percent',
      kind: 'percept',
      source: 'user',
      explicitFact: true,
      tags: ['finance'],
    });
    await gate.encode({
      content: 'Quarterly numbers stayed flat',
      kind: 'percept',
      source: 'user',
      explicitFact: true,
      tags: ['operations'],
    });
    const engine = new ActivationEngine(provider);
    const without = await engine.activate(store, ['finance'], {
      capacity: 4,
      tagWeight: 0,
      lexicalWeight: 0,
      diversityThreshold: 1,
    });
    const withTags = await engine.activate(store, ['finance'], {
      capacity: 4,
      tagWeight: 0.15,
      lexicalWeight: 0,
      diversityThreshold: 1,
    });
    expect(without.workingSet).toHaveLength(0);
    expect(withTags.workingSet[0]?.content).toContain('improved');
    expect(withTags.workingSet[0]?.meta?.['nodeId']).toBeDefined();
  });
});

describe('Episode segmentation and support', () => {
  it('segments by inactivity gap and keeps a discussion together', async () => {
    const { gate, clock } = buildCore();
    const a = (await gate.encode({ content: 'first note', kind: 'percept', source: 'user' }))!;
    clock.advance(5 * MINUTE);
    const b = (await gate.encode({ content: 'second note', kind: 'percept', source: 'user' }))!;
    clock.advance(31 * MINUTE);
    const c = (await gate.encode({ content: 'third note', kind: 'percept', source: 'user' }))!;
    expect(a.episodeId).toBe(b.episodeId);
    expect(c.episodeId).not.toBe(b.episodeId);
  });

  it('boosts the surrounding memories of a discussion', async () => {
    const { gate, store, provider } = buildCore();
    const alpha = [
      'Alpha kickoff: scope agreed',
      'Design review: launch scope agreed',
      'Budget review: launch scope agreed',
      'Hiring review: launch scope agreed',
    ];
    const beta = [
      'Beta kickoff: scope agreed',
      'Design review: beta launch scope agreed',
      'Budget review: beta launch scope agreed',
      'Hiring review: beta launch scope agreed',
    ];
    for (let i = 0; i < alpha.length; i++) {
      await gate.encode({
        content: alpha[i]!,
        kind: 'percept',
        source: 'user',
        episodeId: 'ep-alpha',
      });
      await gate.encode({
        content: beta[i]!,
        kind: 'percept',
        source: 'user',
        episodeId: 'ep-beta',
      });
    }
    const engine = new ActivationEngine(provider);
    const query = 'alpha kickoff';
    const without = await engine.activate(store, [query], {
      capacity: 4,
      episodeWeight: 0,
      diversityThreshold: 1,
    });
    const withEpisode = await engine.activate(store, [query], {
      capacity: 4,
      episodeWeight: 0.3,
      diversityThreshold: 1,
    });
    const alphaCount = (set: { workingSet: Array<{ meta?: Record<string, unknown> }> }) =>
      set.workingSet.filter((chunk) => chunk.meta?.['episodeId'] === 'ep-alpha').length;
    expect(alphaCount(withEpisode)).toBeGreaterThan(alphaCount(without));
    expect(alphaCount(withEpisode)).toBeGreaterThanOrEqual(3);
  });
});

describe('Working-set quotas', () => {
  it('reserves slots for procedural and episodic memory and caps semantic', async () => {
    const { gate, store, provider } = buildCore();
    for (let i = 0; i < 6; i++) {
      await gate.encode({
        content: `service status fact ${i}`,
        kind: 'percept',
        source: 'user',
        explicitFact: true,
      });
    }
    const embed = async (content: string) => (await provider.embed([content]))[0]!;
    const skillEmbedding = await embed('Skill: service status deployment');
    await store.putNode({
      id: 'skill',
      kind: 'procedural',
      scope: 'agent',
      content: 'Skill: service status deployment',
      embedding: skillEmbedding,
      edges: [],
      provenance: { source: 'dream', trust: 0.8 },
      importance: 0.8,
      strength: 1,
      createdAt: 1,
      lastAccessedAt: 1,
      version: 1,
    });
    const episodeEmbedding = await embed('service status incident note');
    await store.putNode({
      id: 'episode',
      kind: 'episodic',
      scope: 'user',
      content: 'service status incident note',
      embedding: episodeEmbedding,
      edges: [],
      provenance: { source: 'user', trust: 1 },
      importance: 0.7,
      strength: 1,
      createdAt: 1,
      lastAccessedAt: 1,
      version: 1,
      episodeId: 'ep-1',
    });

    const engine = new ActivationEngine(provider);
    const baseline = await engine.activate(store, ['service status'], {
      capacity: 4,
      diversityThreshold: 1,
      tagWeight: 0,
      episodeWeight: 0,
    });
    const quotas = await engine.activate(store, ['service status'], {
      capacity: 4,
      diversityThreshold: 1,
      tagWeight: 0,
      episodeWeight: 0,
      reservedKinds: ['procedural', 'episodic'],
      maxPerKind: { semantic: 2 },
    });
    const kinds = (set: { workingSet: Array<{ meta?: Record<string, unknown> }> }) =>
      set.workingSet.map((chunk) => chunk.meta?.['nodeKind']);
    expect(kinds(baseline)).not.toContain('episodic');
    expect(kinds(quotas)).toContain('procedural');
    expect(kinds(quotas)).toContain('episodic');
    expect(kinds(quotas).filter((kind) => kind === 'semantic')).toHaveLength(2);
  });
});
