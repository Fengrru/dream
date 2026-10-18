import {
  ActivationEngine,
  EncodingGate,
  HashingEmbeddingProvider,
  InMemoryStore,
} from '@dream/core';
import { makeTable, mean, pct, type ExperimentResult } from './harness';
import { LIVE_SKIP_NOTE, liveEmbeddingProvider } from './live';

/** Seeded identifiers shaped like real project codes — collision-heavy at dim 256. */
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

interface RetrievalScore {
  hit1: number;
  hit4: number;
  latencyMs: number;
  total: number;
}

interface ConditionOptions {
  lexicalWeight?: number;
  diversityThreshold?: number;
}

async function identifierCollisions(
  engine: ActivationEngine,
  store: InMemoryStore,
  targetIds: string[],
  queries: string[],
  options: ConditionOptions,
): Promise<RetrievalScore> {
  let hit1 = 0;
  let hit4 = 0;
  const latencies: number[] = [];
  for (let i = 0; i < queries.length; i++) {
    const target = targetIds[i];
    const t0 = performance.now();
    const set = await engine.activate(store, [queries[i]!], {
      capacity: 4,
      tagWeight: 0,
      episodeWeight: 0,
      ...options,
    });
    latencies.push(performance.now() - t0);
    const ids = set.workingSet.map((chunk) => chunk.meta?.['nodeId']);
    if (ids[0] === target) hit1++;
    if (ids.includes(target)) hit4++;
  }
  return { hit1, hit4, latencyMs: mean(latencies), total: queries.length };
}

interface DuplicateRow {
  query: string;
  relevantCount: number;
  baselineDistinct: number;
  enhancedDistinct: number;
  baselineDuplicates: number;
  enhancedDuplicates: number;
}


async function liveIdentifierCheck(): Promise<{
  rows: Array<Array<string | number>>;
  note: string;
}> {
  const live = await liveEmbeddingProvider();
  if (!live) return { rows: [], note: LIVE_SKIP_NOTE };
  const provider = live.provider;
  const store = new InMemoryStore();
  const gate = new EncodingGate(store, store, provider);
  const codes = seededCodes(30);
  const facts = codes.map(
    (code) => `Project ${code} uses Postgres for storage and deploys to Frankfurt.`,
  );
  for (const fact of facts) {
    await gate.encode({ content: fact, kind: 'percept', source: 'user', explicitFact: true });
  }
  const idByContent = new Map<string, string>();
  for (const node of await store.listNodes()) idByContent.set(node.content, node.id);
  const engine = new ActivationEngine(provider);
  const measure = async (options: ConditionOptions) => {
    let hit1 = 0;
    let hit4 = 0;
    for (let i = 0; i < codes.length; i++) {
      const target = idByContent.get(facts[i]!);
      const set = await engine.activate(store, [`Which database does project ${codes[i]} use?`], {
        capacity: 4,
        tagWeight: 0,
        episodeWeight: 0,
        ...options,
      });
      const ids = set.workingSet.map((chunk) => chunk.meta?.['nodeId']);
      if (ids[0] === target) hit1++;
      if (ids.includes(target)) hit4++;
    }
    return { hit1: pct(hit1 / codes.length), hit4: pct(hit4 / codes.length) };
  };
  const vector = await measure({ lexicalWeight: 0, diversityThreshold: 1 });
  const hybrid = await measure({});
  return {
    rows: [
      ['vector only', `${vector.hit1}%`, `${vector.hit4}%`],
      ['hybrid', `${hybrid.hit1}%`, `${hybrid.hit4}%`],
    ],
    note: `live embeddings: ${live.label} (30 facts)`,
  };
}

async function duplicateCrowding(
  engine: ActivationEngine,
  store: InMemoryStore,
  queries: Array<{ query: string; relevant: string[] }>,
): Promise<DuplicateRow[]> {
  const rows: DuplicateRow[] = [];
  for (const { query, relevant } of queries) {
    const relevantSet = new Set(relevant);
    const measure = async (options: ConditionOptions) => {
      const set = await engine.activate(store, [query], {
        capacity: 4,
        tagWeight: 0,
        episodeWeight: 0,
        ...options,
      });
      const contents = set.workingSet.map((chunk) => chunk.content);
      return {
        distinct: new Set(contents.filter((content) => relevantSet.has(content))).size,
        duplicates: contents.length - new Set(contents).size,
      };
    };
    const baseline = await measure({ lexicalWeight: 0, diversityThreshold: 1 });
    const enhanced = await measure({});
    rows.push({
      query,
      relevantCount: relevant.length,
      baselineDistinct: baseline.distinct,
      enhancedDistinct: enhanced.distinct,
      baselineDuplicates: baseline.duplicates,
      enhancedDuplicates: enhanced.duplicates,
    });
  }
  return rows;
}

/**
 * E8 — Retrieval robustness: hybrid lexical channel + working-set diversity.
 *
 * Two failure modes that pure cosine activation cannot fix on its own:
 *  1. Exact identifiers collide in a hashed embedding space; a keyword/BM25
 *     channel resolves the exact token and demotes lookalikes (Hy-Memory's
 *     hybrid reader).
 *  2. Repeated paraphrase copies consume the capacity-limited working set;
 *     a diversity pass defers near-duplicates so four slots cover four facts
 *     (Hy-Memory's search-time dedup).
 *
 * A third stress case (keyword-stuffed logs) checks length normalization:
 * repetitive documents dominate pure TF cosine but lose to short precise facts
 * under BM25.
 */
export async function e8Retrieval(): Promise<ExperimentResult> {
  // Scenario 1: identifier collisions (N=200 facts sharing one template).
  const provider = new HashingEmbeddingProvider(256);
  const store = new InMemoryStore();
  const gate = new EncodingGate(store, store, provider);
  const codes = seededCodes(200);
  const facts = codes.map(
    (code) => `Project ${code} uses Postgres for storage and deploys to the Frankfurt region.`,
  );
  for (const fact of facts) {
    await gate.encode({ content: fact, kind: 'percept', source: 'user', explicitFact: true });
  }
  const idByContent = new Map<string, string>();
  for (const node of await store.listNodes()) idByContent.set(node.content, node.id);
  const targetIds = facts.map((fact) => idByContent.get(fact)!);
  const identifierQueries = codes.map((code) => `Which database does project ${code} use?`);

  const engine = new ActivationEngine(provider);
  const identifierBase = await identifierCollisions(engine, store, targetIds, identifierQueries, {
    lexicalWeight: 0,
    diversityThreshold: 1,
  });
  const identifierHybrid = await identifierCollisions(engine, store, targetIds, identifierQueries, {});

  // Scenario 2: keyword-stuffed logs.
  const stuffedStore = new InMemoryStore();
  const stuffedGate = new EncodingGate(stuffedStore, stuffedStore, provider);
  const services = Array.from({ length: 20 }, (_, i) => `svc${String(i).padStart(2, '0')}`);
  const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
  const hours = ['1am', '2am', '3am', '4am', '5am'];
  const stuffedFacts: string[] = [];
  for (let i = 0; i < services.length; i++) {
    const service = services[i]!;
    const fact = `The ${service} service deploy window is ${days[i % days.length]} at ${hours[i % hours.length]} UTC.`;
    stuffedFacts.push(fact);
    await stuffedGate.encode({ content: fact, kind: 'percept', source: 'user', explicitFact: true });
    const stuffing = Array.from({ length: 12 }, () => `${service} service deploy window `.repeat(10)).join(' ');
    for (let k = 0; k < 4; k++) {
      await stuffedGate.encode({
        content: `Session log ${i}-${k}: ${stuffing}`,
        kind: 'percept',
        source: 'tool',
      });
    }
  }
  const stuffedIdsByContent = new Map<string, string>();
  for (const node of await stuffedStore.listNodes()) stuffedIdsByContent.set(node.content, node.id);
  const stuffedTargets = stuffedFacts.map((fact) => stuffedIdsByContent.get(fact)!);
  const stuffedQueries = services.map((service) => `When is the ${service} service deploy window?`);
  const stuffedBase = await identifierCollisions(engine, stuffedStore, stuffedTargets, stuffedQueries, {
    lexicalWeight: 0,
    diversityThreshold: 1,
  });
  const stuffedHybrid = await identifierCollisions(engine, stuffedStore, stuffedTargets, stuffedQueries, {});
  const live = await liveIdentifierCheck();

  // Scenario 3: duplicate crowding (6 facts x 3 independently-important copies).
  const duplicateStore = new InMemoryStore();
  const duplicateGate = new EncodingGate(duplicateStore, duplicateStore, provider);
  const familyFacts = [
    'My sister Ada lives in Seattle.',
    'My sister Grace lives in Austin.',
    'My sister Joan lives in Paris.',
    'My brother Tim lives in Oslo.',
    'My brother Alan lives in Denver.',
    'My brother Ken lives in Tokyo.',
  ];
  for (const content of familyFacts) {
    for (let copy = 0; copy < 3; copy++) {
      const node = (await duplicateGate.encode({
        content,
        kind: 'percept',
        source: 'user',
        explicitFact: true,
      }))!;
      // Duplicates arrive from different sessions/sources with equal salience —
      // exactly the case where pure ranking fills every slot with one fact.
      node.importance = 0.9;
      node.strength = 1;
      await duplicateStore.putNode(node);
    }
  }
  const sisters = familyFacts.slice(0, 3);
  const brothers = familyFacts.slice(3);
  const duplicateRows = await duplicateCrowding(engine, duplicateStore, [
    { query: 'Where do my sisters live?', relevant: sisters },
    { query: 'Where do my brothers live?', relevant: brothers },
    { query: 'Where do my sisters and brothers live?', relevant: familyFacts },
  ]);
  const avg = (values: number[]): number => Math.round(mean(values) * 100) / 100;
  const baselineDistinct = avg(duplicateRows.map((row) => row.baselineDistinct));
  const enhancedDistinct = avg(duplicateRows.map((row) => row.enhancedDistinct));
  const baselineDuplicates = avg(duplicateRows.map((row) => row.baselineDuplicates));
  const enhancedDuplicates = avg(duplicateRows.map((row) => row.enhancedDuplicates));

  const rows: Array<Array<string | number>> = [
    [
      'identifier collisions (N=200)',
      `${pct(identifierBase.hit1 / identifierBase.total)}%`,
      `${pct(identifierHybrid.hit1 / identifierHybrid.total)}%`,
      `${pct(identifierBase.hit4 / identifierBase.total)}%`,
      `${pct(identifierHybrid.hit4 / identifierHybrid.total)}%`,
    ],
    [
      'keyword-stuffed logs (20 facts)',
      `${pct(stuffedBase.hit1 / stuffedBase.total)}%`,
      `${pct(stuffedHybrid.hit1 / stuffedHybrid.total)}%`,
      `${pct(stuffedBase.hit4 / stuffedBase.total)}%`,
      `${pct(stuffedHybrid.hit4 / stuffedHybrid.total)}%`,
    ],
  ];

  const distinctRows: Array<Array<string | number>> = duplicateRows.map((row) => [
    `${row.query} (${row.relevantCount} relevant)`,
    row.relevantCount,
    row.baselineDistinct,
    row.enhancedDistinct,
  ]);

  const latencyRows: Array<Array<string | number>> = [
    ['vector only', Math.round(identifierBase.latencyMs * 100) / 100],
    ['hybrid (+ BM25 + diversity)', Math.round(identifierHybrid.latencyMs * 100) / 100],
    ['overhead factor', Math.round((identifierHybrid.latencyMs / identifierBase.latencyMs) * 100) / 100],
  ];

  const improvedRanking =
    (identifierHybrid.hit1 - identifierBase.hit1) / identifierBase.total > 0.2 &&
    (stuffedHybrid.hit1 - stuffedBase.hit1) / stuffedBase.total > 0.2;
  const improvedDiversity = enhancedDistinct > baselineDistinct;
  // Sub-millisecond ratio measurements are unstable; judge against the
  // absolute personal-scale budget too.
  const acceptableLatency =
    identifierHybrid.latencyMs < 25 && identifierHybrid.latencyMs < identifierBase.latencyMs * 5;

  const findings = [
    `Identifier collisions: baseline recall@1 was ${pct(identifierBase.hit1 / identifierBase.total)}% while recall@4 was ` +
      `${pct(identifierBase.hit4 / identifierBase.total)}% — a pure RANKING failure predicted in E1's corpus boundary. ` +
      `The hybrid channel raised recall@1 to ${pct(identifierHybrid.hit1 / identifierHybrid.total)}% (recall@4 ${pct(identifierHybrid.hit4 / identifierHybrid.total)}%).`,
    `Keyword-stuffed logs: pure vector activation put the precise fact top-1 in ${stuffedBase.hit1}/${stuffedBase.total} queries; ` +
      `BM25 length normalization + IDF raised it to ${stuffedHybrid.hit1}/${stuffedHybrid.total}.`,
    `Duplicate crowding: the diversity pass raised distinct relevant facts in the 4-slot working set from ` +
      `${baselineDistinct} to ${enhancedDistinct} on average and cut duplicate slots from ` +
      `${baselineDuplicates} to ${enhancedDuplicates}.`,
    live.rows.length > 0
      ? `Live embeddings (${live.note}): ${live.rows.map((row) => `${row[0]} @1=${row[1]} @4=${row[2]}`).join('; ')}.`
      : `Live embedding check ${live.note}.`,
    `Cost: hybrid activation averaged ${Math.round(identifierHybrid.latencyMs * 100) / 100} ms vs ` +
      `${Math.round(identifierBase.latencyMs * 100) / 100} ms vector-only at N=200 (factor ` +
      `${Math.round((identifierHybrid.latencyMs / identifierBase.latencyMs) * 100) / 100}); the absolute ` +
      `budget is what matters at sub-millisecond scale and stays well inside a turn.`,
  ];

  return {
    id: 'E8',
    title: 'Hybrid lexical retrieval & working-set diversity',
    question: 'Can a BM25 channel and a diversity pass make recall robust to identifier collisions, keyword stuffing, and paraphrase crowding?',
    hypothesis:
      'Hashed embeddings rank by token overlap without IDF or length normalization, so exact identifiers collide and repetitive noise wins; BM25 fusion plus a near-duplicate filter fixes ranking and coverage without material latency cost.',
    method: [
      'Scenario 1: 200 same-template facts with unique seeded identifiers; query each identifier; compare vector-only vs hybrid recall@1/@4.',
      'Scenario 2: 20 concise facts plus 4 keyword-stuffed logs each; ask each fact question; compare fact recall@1/@4.',
      'Scenario 3: 6 family facts, each duplicated 3x with equal salience; measure distinct relevant facts in the 4-slot working set, vector-only vs diversity pass.',
      'Measure activation latency at N=200 to price the extra lexical scan.',
    ],
    tables: [
      makeTable(
        'Adversarial recall: vector-only vs hybrid',
        ['scenario', 'baseline recall@1', 'hybrid recall@1', 'baseline recall@4', 'hybrid recall@4'],
        rows,
      ),
      makeTable(
        'Working-set coverage under paraphrase crowding',
        ['query', 'relevant facts', 'baseline distinct @4', 'diversity distinct @4'],
        distinctRows,
      ),
      makeTable('Activation cost at N=200', ['condition', 'avg ms'], latencyRows),
    ],
    findings,
    recommendations: [
      'Keep the hybrid lexical channel on by default for the hashing embedder; revisit the weight when a real embedding provider is wired (E1 recommendation).',
      'Keep the diversity pass: it costs one cosine per selected slot and prevents paraphrase clusters from starving the capacity-limited working set.',
      'Treat lexical and vector channels as complementary, not redundant — the vector channel still handles fuzzy similarity; the lexical channel resolves exact tokens.',
    ],
    verdict: improvedRanking && improvedDiversity && acceptableLatency ? 'works' : 'partial',
  };
}
