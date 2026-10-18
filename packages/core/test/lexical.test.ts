import { describe, expect, it } from 'vitest';
import { ActivationEngine } from '../src/activation';
import { bm25Rank } from '../src/lexical';
import { buildCore } from './helpers';

/** Seeded, human-like identifiers (3 letters + 4 digits) — collision-heavy at dim 256. */
function seededCodes(n: number): string[] {
  let state = 42;
  const rand = (): number => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  return Array.from({ length: n }, () => {
    let code = '';
    for (let i = 0; i < 3; i++) code += alphabet[Math.floor(rand() * alphabet.length)];
    return `${code}${1000 + Math.floor(rand() * 9000)}`;
  });
}

describe('BM25 lexical ranking', () => {
  it('prefers a short precise fact over a long keyword-stuffed log', () => {
    const fact = 'The billing service deploy window is Friday at 2am UTC.';
    const stuffed =
      'Session log: deploy window billing service deploy window billing service ' +
      'deploy window billing service deploy window billing service, parser fix ' +
      'reviewed pull requests moved the retro to thursday.';
    const hits = bm25Rank(
      [
        { id: 'fact', text: fact },
        { id: 'noise', text: stuffed },
      ],
      'When is the billing service deploy window?',
    );
    const byId = new Map(hits.map((hit) => [hit.id, hit]));
    expect(byId.get('fact')!.score).toBeGreaterThan(byId.get('noise')!.score);
    expect(byId.get('fact')!.normalized).toBeCloseTo(1);
  });
});

describe('Hybrid lexical channel', () => {
  it('rescues exact identifiers that collide in the hashed embedding space', async () => {
    const { gate, store, provider } = buildCore();
    const codes = seededCodes(80);
    for (const code of codes) {
      await gate.encode({
        content: `Project ${code} uses Postgres for storage and deploys to the Frankfurt region.`,
        kind: 'percept',
        source: 'user',
        explicitFact: true,
      });
    }
    const engine = new ActivationEngine(provider);
    const idByContent = new Map<string, string>();
    for (const node of await store.listNodes()) idByContent.set(node.content, node.id);

    let baselineHits = 0;
    let hybridHits = 0;
    for (const code of codes) {
      const target = idByContent.get(
        `Project ${code} uses Postgres for storage and deploys to the Frankfurt region.`,
      );
      const query = `Which database does project ${code} use?`;
      const baseline = await engine.activate(store, [query], {
        lexicalWeight: 0,
        diversityThreshold: 1,
        tagWeight: 0,
        episodeWeight: 0,
      });
      const hybrid = await engine.activate(store, [query], {
        tagWeight: 0,
        episodeWeight: 0,
      });
      if (baseline.workingSet[0]?.meta?.['nodeId'] === target) baselineHits++;
      if (hybrid.workingSet[0]?.meta?.['nodeId'] === target) hybridHits++;
    }

    expect(baselineHits / codes.length).toBeLessThan(0.5);
    expect(hybridHits / codes.length).toBeGreaterThan(0.95);
  });
});

describe('Working-set diversity', () => {
  it('does not let paraphrase copies consume every slot', async () => {
    const { gate, store, provider } = buildCore();
    const encodePinned = async (content: string): Promise<void> => {
      const node = (await gate.encode({
        content,
        kind: 'percept',
        source: 'user',
        explicitFact: true,
      }))!;
      // Simulate duplicates arriving from different sessions/sources: each is
      // independently important, so pure ranking would let them fill the set.
      node.importance = 0.9;
      node.strength = 1;
      await store.putNode(node);
    };
    for (let i = 0; i < 3; i++) await encodePinned('My sister Ada lives in Seattle.');
    for (const content of [
      'My brother Tim lives in Oslo.',
      'My sister Grace lives in Austin.',
      'My brother Alan lives in Denver.',
    ]) {
      await encodePinned(content);
    }

    const engine = new ActivationEngine(provider);
    const query = 'Where do my sister and brother live?';
    const baseline = await engine.activate(store, [query], {
      lexicalWeight: 0,
      diversityThreshold: 1,
    });
    const diverse = await engine.activate(store, [query], {});

    const distinct = (set: { workingSet: Array<{ content: string }> }) =>
      new Set(set.workingSet.map((chunk) => chunk.content)).size;
    expect(distinct(diverse)).toBeGreaterThan(distinct(baseline));
    expect(distinct(diverse)).toBe(4);
  });

  it('keeps repeated episodic events distinct by default', async () => {
    const { gate, store, provider } = buildCore();
    for (let i = 0; i < 3; i++) {
      const node = (await gate.encode({
        content: 'took the morning medication',
        kind: 'percept',
        source: 'user',
      }))!;
      node.importance = 0.9;
      node.strength = 1;
      await store.putNode(node);
    }
    const engine = new ActivationEngine(provider);
    const query = 'morning medication';
    const defaultSet = await engine.activate(store, [query], { capacity: 4 });
    expect(defaultSet.workingSet).toHaveLength(3);
    const episodicDedup = await engine.activate(store, [query], {
      capacity: 4,
      diversityKinds: ['episodic'],
    });
    expect(episodicDedup.workingSet).toHaveLength(1);
  });
});
