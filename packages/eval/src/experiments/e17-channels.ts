import {
  ActivationEngine,
  EncodingGate,
  HashingEmbeddingProvider,
  InMemoryStore,
} from '@dream/core';
import { FakeClock } from '../instance';
import { makeTable, type ExperimentResult } from './harness';

const MINUTE = 60 * 1000;

async function tagScenario(): Promise<{
  without: string;
  withTags: string;
  withoutCount: number;
  withCount: number;
}> {
  const provider = new HashingEmbeddingProvider(256);
  const store = new InMemoryStore();
  const gate = new EncodingGate(store, store, provider);
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
  return {
    without: without.workingSet[0]?.content ?? '(none)',
    withTags: withTags.workingSet[0]?.content ?? '(none)',
    withoutCount: without.workingSet.length,
    withCount: withTags.workingSet.length,
  };
}

async function episodeScenario(): Promise<{
  distinctEpisodes: number;
  alphaWithout: number;
  alphaWith: number;
}> {
  const provider = new HashingEmbeddingProvider(256);
  const store = new InMemoryStore();
  const clock = new FakeClock();
  const gate = new EncodingGate(store, store, provider, undefined, clock.now);

  const first = (await gate.encode({ content: 'first note', kind: 'percept', source: 'user' }))!;
  clock.advance(5 * MINUTE);
  const second = (await gate.encode({ content: 'second note', kind: 'percept', source: 'user' }))!;
  clock.advance(31 * MINUTE);
  const third = (await gate.encode({ content: 'third note', kind: 'percept', source: 'user' }))!;
  const distinctEpisodes = new Set([first.episodeId, second.episodeId, third.episodeId]).size;

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
    await gate.encode({ content: alpha[i]!, kind: 'percept', source: 'user', episodeId: 'ep-alpha' });
    await gate.encode({ content: beta[i]!, kind: 'percept', source: 'user', episodeId: 'ep-beta' });
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
  return { distinctEpisodes, alphaWithout: alphaCount(without), alphaWith: alphaCount(withEpisode) };
}

async function quotaScenario(): Promise<{
  baseline: string[];
  quotas: string[];
}> {
  const provider = new HashingEmbeddingProvider(256);
  const store = new InMemoryStore();
  const gate = new EncodingGate(store, store, provider);
  for (let i = 0; i < 6; i++) {
    await gate.encode({
      content: `service status fact ${i}`,
      kind: 'percept',
      source: 'user',
      explicitFact: true,
    });
  }
  const embed = async (content: string) => (await provider.embed([content]))[0]!;
  await store.putNode({
    id: 'skill',
    kind: 'procedural',
    scope: 'agent',
    content: 'Skill: service status deployment',
    embedding: await embed('Skill: service status deployment'),
    edges: [],
    provenance: { source: 'dream', trust: 0.8 },
    importance: 0.8,
    strength: 1,
    createdAt: 1,
    lastAccessedAt: 1,
    version: 1,
  });
  await store.putNode({
    id: 'episode',
    kind: 'episodic',
    scope: 'user',
    content: 'service status incident note',
    embedding: await embed('service status incident note'),
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
    set.workingSet.map((chunk) => String(chunk.meta?.['nodeKind']));
  return { baseline: kinds(baseline), quotas: kinds(quotas) };
}

/**
 * E17 — Channel orchestration: entity tags, episodes, quotas.
 *
 * The working set has four slots. Without orchestration, a large semantic
 * cluster can consume all of them; exact entities, discussion context and
 * procedural skills never surface. This experiment checks the three channels
 * and the reservation policy independently.
 */
export async function e17Channels(): Promise<ExperimentResult> {
  const tags = await tagScenario();
  const episodes = await episodeScenario();
  const quotas = await quotaScenario();

  const tagPassed = tags.withoutCount === 0 && tags.withCount > 0 && tags.withTags.includes('improved');
  const episodePassed = episodes.distinctEpisodes === 2 && episodes.alphaWith > episodes.alphaWithout;
  const quotaPassed =
    !quotas.baseline.includes('episodic') &&
    quotas.quotas.includes('procedural') &&
    quotas.quotas.includes('episodic') &&
    quotas.quotas.filter((kind) => kind === 'semantic').length === 2;

  const rows: Array<Array<string | number>> = [
    [
      'entity tag (query "finance")',
      `${tags.withoutCount} result: ${tags.without}`,
      `${tags.withCount} result: ${tags.withTags}`,
    ],
    [
      'episode segmentation (30 min gap)',
      'expected 2 episodes',
      `${episodes.distinctEpisodes} episodes`,
    ],
    [
      'episode support (alpha share of top-4)',
      `${episodes.alphaWithout}/4`,
      `${episodes.alphaWith}/4`,
    ],
    [
      'slot quotas (kinds in top-4)',
      quotas.baseline.join(' + '),
      quotas.quotas.join(' + '),
    ],
  ];

  const findings = [
    `Entity tags: the tag-only query returned ${tags.withoutCount} memories without the channel and ${tags.withCount} with it; the top result became "${tags.withTags}".`,
    `Episode segmentation: a 31-minute gap split the discussion (${episodes.distinctEpisodes} episodes), while a 5-minute gap stayed in one.`,
    `Episode support: anchoring on the strongest hit raised the same-discussion share of the 4-slot set from ${episodes.alphaWithout}/4 to ${episodes.alphaWith}/4.`,
    `Quotas: rank-only selection produced [${quotas.baseline.join(', ')}]; reserving procedural/episodic and capping semantic produced [${quotas.quotas.join(', ')}].`,
    `All three channels are opt-in weights/reservations; existing experiments keep their previous behavior because the engine defaults remain interpolation, no reservations, and episodeWeight 0.`,
  ];

  return {
    id: 'E17',
    title: 'Channel orchestration: tags, episodes, quotas',
    question: 'Can exact entities, discussion context and procedural skills reach the 4-slot working set without starving core facts?',
    hypothesis:
      'A tag channel nominates explicit entities, episode anchoring brings surrounding discussion context, and reservations/caps prevent one channel from consuming every slot.',
    method: [
      'Query a finance fact whose content never says "finance"; compare tagWeight 0 vs 0.15.',
      'Encode notes with 5- and 31-minute gaps; verify episode segmentation; compare alpha discussion share in top-4 with episodeWeight 0 vs 0.3.',
      'Build 6 semantic + 1 procedural + 1 episodic candidates; compare rank-only selection with reservedKinds and maxPerKind.',
    ],
    tables: [
      makeTable('Channel behavior', ['scenario', 'without', 'with'], rows),
    ],
    findings,
    recommendations: [
      'Keep tag extraction deterministic and cheap; explicit tags are often the only bridge between a query and a memory phrased differently.',
      'Anchor episodes on the single strongest hit, not on every group: boosting the largest cluster rewards size, not relevance.',
      'Use reservations sparingly; a reserved slot is a deliberate statement that a kind must be represented, not a general ranking rule.',
    ],
    verdict: tagPassed && episodePassed && quotaPassed ? 'works' : 'partial',
  };
}
