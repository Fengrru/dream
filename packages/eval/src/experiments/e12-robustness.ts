import {
  ActivationEngine,
  EncodingGate,
  HashingEmbeddingProvider,
  InMemoryStore,
  type EmbeddingProvider,
} from '@dream/core';
import { makeTable, mean, pct, type ExperimentResult } from './harness';

interface Score {
  hit1: number;
  hit4: number;
  total: number;
}

interface Options {
  lexicalWeight?: number;
  diversityThreshold?: number;
}

function seededRand(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededCodes(seed: number, n: number): string[] {
  const rand = seededRand(seed);
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  return Array.from({ length: n }, () => {
    let code = '';
    for (let i = 0; i < 3; i++) code += alphabet[Math.floor(rand() * alphabet.length)];
    return `${code}${1000 + Math.floor(rand() * 9000)}`;
  });
}

async function identifierCorpus(seed: number, options: Options): Promise<Score> {
  const provider = new HashingEmbeddingProvider(256);
  const store = new InMemoryStore();
  const gate = new EncodingGate(store, store, provider);
  const codes = seededCodes(seed, 120);
  const facts = codes.map(
    (code) => `Project ${code} uses Postgres for storage and deploys to the Frankfurt region.`,
  );
  for (const fact of facts) {
    await gate.encode({ content: fact, kind: 'percept', source: 'user', explicitFact: true });
  }
  const idByContent = new Map<string, string>();
  for (const node of await store.listNodes()) idByContent.set(node.content, node.id);
  const engine = new ActivationEngine(provider);
  let hit1 = 0;
  let hit4 = 0;
  for (let i = 0; i < codes.length; i++) {
    const target = idByContent.get(facts[i]!);
    const set = await engine.activate(store, [`Which database does project ${codes[i]} use?`], {
      capacity: 4,
      ...options,
    });
    const ids = set.workingSet.map((chunk) => chunk.meta?.['nodeId']);
    if (ids[0] === target) hit1++;
    if (ids.includes(target)) hit4++;
  }
  return { hit1, hit4, total: codes.length };
}

async function duplicateCorpus(options: Options): Promise<{ distinct: number; duplicates: number }> {
  const provider = new HashingEmbeddingProvider(256);
  const store = new InMemoryStore();
  const gate = new EncodingGate(store, store, provider);
  const facts = [
    'My sister Ada lives in Seattle.',
    'My sister Grace lives in Austin.',
    'My sister Joan lives in Paris.',
    'My brother Tim lives in Oslo.',
    'My brother Alan lives in Denver.',
    'My brother Ken lives in Tokyo.',
  ];
  for (const content of facts) {
    for (let copy = 0; copy < 3; copy++) {
      const node = (await gate.encode({
        content,
        kind: 'percept',
        source: 'user',
        explicitFact: true,
      }))!;
      node.importance = 0.9;
      node.strength = 1;
      await store.putNode(node);
    }
  }
  const engine = new ActivationEngine(provider);
  const set = await engine.activate(store, ['Where do my sisters and brothers live?'], {
    capacity: 4,
    ...options,
  });
  const contents = set.workingSet.map((chunk) => chunk.content);
  return {
    distinct: new Set(contents).size,
    duplicates: contents.length - new Set(contents).size,
  };
}

interface HeldOutCase {
  fact: string;
  question: string;
}

function heldOutCorpus(): { cases: HeldOutCase[]; noise: string[] } {
  const cases: HeldOutCase[] = [
    { fact: '我的表姐周雨桐住在苏州。', question: '周雨桐住在哪里？' },
    { fact: '我的同事陈浩然住在青岛。', question: '陈浩然住在哪里？' },
    { fact: '项目「银河14号」使用 PostgreSQL 存储。', question: '银河14号项目使用什么数据库？' },
    { fact: '项目「天穹8号」部署在法兰克福。', question: '天穹8号项目部署在哪里？' },
    { fact: '服务「订单服务3」的部署窗口是周四凌晨2点。', question: '订单服务3的部署窗口是什么时候？' },
    { fact: 'My friend Ada lives in Lisbon.', question: 'Where does Ada live?' },
    { fact: 'My friend Grace lives in Osaka.', question: 'Where does Grace live?' },
    { fact: 'The billing service deploy window is Friday at 2am UTC.', question: 'When is the billing service deploy window?' },
    { fact: 'Flight QF27 departs on Wednesday at 3pm.', question: 'When does flight QF27 depart?' },
    { fact: 'The storage locker combination is 4821.', question: 'What is the locker combination?' },
    { fact: '我的妹妹林小雨在杭州工作。', question: '林小雨在哪里工作？' },
    { fact: '我的哥哥张志强在成都工作。', question: '张志强在哪里工作？' },
    { fact: '项目「朱雀5号」使用 Redis 缓存。', question: '朱雀5号项目使用什么缓存？' },
    { fact: 'Project ORB4471 uses Kafka for events.', question: 'What does project ORB4471 use for events?' },
    { fact: 'The quarterly review is on November 3 at 10am.', question: 'When is the quarterly review?' },
  ];
  const noise = [
    'weekly sync note: shipped the parser fix, reviewed two pull requests, moved the retro to thursday',
    '会话日志：部署窗口 服务 部署窗口 服务 部署窗口 服务，修复解析器并评审两个拉取请求',
    'tool output: cache warmed, 42 keys evicted, p95 latency 18ms',
  ];
  return { cases, noise };
}

async function heldOut(provider: EmbeddingProvider, options: Options): Promise<Score> {
  const store = new InMemoryStore();
  const gate = new EncodingGate(store, store, provider);
  const { cases, noise } = heldOutCorpus();
  for (const item of cases) {
    await gate.encode({ content: item.fact, kind: 'percept', source: 'user', explicitFact: true });
  }
  for (const item of noise) {
    await gate.encode({ content: item, kind: 'percept', source: 'tool' });
  }
  const idByContent = new Map<string, string>();
  for (const node of await store.listNodes()) idByContent.set(node.content, node.id);
  const engine = new ActivationEngine(provider);
  let hit1 = 0;
  let hit4 = 0;
  for (const item of cases) {
    const target = idByContent.get(item.fact);
    const set = await engine.activate(store, [item.question], { capacity: 4, ...options });
    const ids = set.workingSet.map((chunk) => chunk.meta?.['nodeId']);
    if (ids[0] === target) hit1++;
    if (ids.includes(target)) hit4++;
  }
  return { hit1, hit4, total: cases.length };
}

interface LiveRow {
  weight: number;
  recall1: number;
  recall4: number;
}

async function liveEmbeddingSweep(): Promise<{ rows: LiveRow[]; note: string }> {
  const apiKey = process.env.DREAM_EMBEDDING_API_KEY ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { rows: [], note: 'skipped — no DREAM_EMBEDDING_API_KEY / OPENAI_API_KEY' };
  }
  try {
    const { OpenAIEmbeddingProvider } = await import('@dream/core');
    const provider = new OpenAIEmbeddingProvider({
      apiKey,
      baseUrl: process.env.DREAM_EMBEDDING_BASE_URL,
      model: process.env.DREAM_EMBEDDING_MODEL,
    });
    const rows: LiveRow[] = [];
    for (const weight of [0, 0.2, 0.4]) {
      const score = await heldOut(provider, { lexicalWeight: weight });
      rows.push({
        weight,
        recall1: Math.round((score.hit1 / score.total) * 1000) / 10,
        recall4: Math.round((score.hit4 / score.total) * 1000) / 10,
      });
    }
    return { rows, note: `live embeddings: ${process.env.DREAM_EMBEDDING_MODEL ?? 'text-embedding-3-small'}` };
  } catch (err) {
    return { rows: [], note: `live embeddings failed: ${String(err).slice(0, 80)}` };
  }
}

/**
 * E12 — Robustness, ablations, and a held-out corpus.
 *
 * E8 showed the combined mechanism works on one seed. This experiment asks the
 * harder questions: does it hold across seeds, which channel causes the gain,
 * and does it survive a held-out corpus written after the mechanisms were
 * built? A live embedding sweep is included when an API key is present.
 */
export async function e12Robustness(): Promise<ExperimentResult> {
  const seeds = [1, 2, 3, 4, 5];
  const seedRows: Array<Array<string | number>> = [];
  const vectorScores: number[] = [];
  const hybridScores: number[] = [];
  for (const seed of seeds) {
    const vector = await identifierCorpus(seed, { lexicalWeight: 0, diversityThreshold: 1 });
    const hybrid = await identifierCorpus(seed, {});
    const v1 = vector.hit1 / vector.total;
    const h1 = hybrid.hit1 / hybrid.total;
    vectorScores.push(v1);
    hybridScores.push(h1);
    seedRows.push([seed, pct(v1) + '%', pct(h1) + '%', pct(vector.hit4 / vector.total) + '%', pct(hybrid.hit4 / hybrid.total) + '%']);
  }
  seedRows.push([
    'mean',
    pct(mean(vectorScores)) + '%',
    pct(mean(hybridScores)) + '%',
    '—',
    '—',
  ]);

  const ablationRows: Array<Array<string | number>> = [];
  for (const condition of [
    { label: 'vector only', options: { lexicalWeight: 0, diversityThreshold: 1 } },
    { label: '+ lexical', options: { lexicalWeight: 0.4, diversityThreshold: 1 } },
    { label: '+ diversity', options: { lexicalWeight: 0, diversityThreshold: 0.95 } },
    { label: '+ both', options: {} },
  ]) {
    const identifier = await identifierCorpus(1, condition.options);
    const duplicate = await duplicateCorpus(condition.options);
    ablationRows.push([
      condition.label,
      pct(identifier.hit1 / identifier.total) + '%',
      duplicate.distinct,
      duplicate.duplicates,
    ]);
  }

  const provider = new HashingEmbeddingProvider(256);
  const heldOutVector = await heldOut(provider, { lexicalWeight: 0, diversityThreshold: 1 });
  const heldOutFull = await heldOut(provider, {});
  const live = await liveEmbeddingSweep();

  const meanVector = mean(vectorScores);
  const meanHybrid = mean(hybridScores);
  const stable = hybridScores.every((score) => score >= 0.95);
  const ablationLexical = Number(String(ablationRows[1]?.[1] ?? '').replace('%', '')) > 20;
  const ablationDiversity = Number(ablationRows[2]?.[2] ?? 0) > Number(ablationRows[0]?.[2] ?? 0);
  const heldOutPassed =
    heldOutFull.hit4 / heldOutFull.total >= heldOutVector.hit4 / heldOutVector.total &&
    heldOutFull.hit4 / heldOutFull.total >= 0.8;

  const findings = [
    `Across ${seeds.length} seeds, identifier recall@1 moved from ${pct(meanVector)}% (vector only) to ${pct(meanHybrid)}% (hybrid); every seed stayed at or above ${pct(Math.min(...hybridScores))}%.`,
    `Ablation: the lexical channel alone raised identifier recall@1 to ${ablationRows[1]![1]}; the diversity pass alone raised distinct duplicate coverage to ${ablationRows[2]![2]} (vector only: ${ablationRows[0]![2]}). The gains are independent, not one mechanism masking the other.`,
    `Held-out corpus (Chinese + English, written after the mechanisms): recall@4 ${pct(heldOutVector.hit4 / heldOutVector.total)}% vector-only -> ${pct(heldOutFull.hit4 / heldOutFull.total)}% full stack. The corpus is realistic rather than adversarial, so it evidences no regression rather than a separation; E9/E8 carry the separation.`,
    live.rows.length > 0
      ? `Live embedding sweep: ${live.rows.map((row) => `weight ${row.weight} → recall@4 ${row.recall4}%`).join(', ')}.`
      : `Live embedding sweep ${live.note}; hash-embedder conclusions remain evidence for the offline default only.`,
  ];

  return {
    id: 'E12',
    title: 'Seed stability, ablations & held-out corpus',
    question: 'Is the retrieval improvement stable across seeds, attributable to the right channels, and transferable to a held-out corpus?',
    hypothesis:
      'The lexical channel drives identifier gains, the diversity pass drives coverage gains, both are stable across seeds, and the combined stack still helps on a corpus written after the implementation.',
    method: [
      'Run the identifier-collision corpus on five seeds and report recall@1/@4 plus the mean.',
      'Ablate: vector only, +lexical, +diversity, +both; measure identifier recall@1 and duplicate coverage.',
      'Evaluate a held-out mixed Chinese/English personal-memory corpus with vector-only vs the full stack.',
      'Optionally sweep lexicalWeight 0/0.2/0.4 with a live OpenAI-compatible embedding endpoint.',
    ],
    tables: [
      makeTable(
        'Identifier collisions by seed',
        ['seed', 'vector recall@1', 'hybrid recall@1', 'vector recall@4', 'hybrid recall@4'],
        seedRows,
      ),
      makeTable(
        'Ablation',
        ['condition', 'identifier recall@1', 'distinct duplicate coverage', 'duplicate slots'],
        ablationRows,
      ),
      makeTable(
        'Held-out corpus',
        ['condition', 'recall@1', 'recall@4'],
        [
          ['vector only', pct(heldOutVector.hit1 / heldOutVector.total) + '%', pct(heldOutVector.hit4 / heldOutVector.total) + '%'],
          ['full stack', pct(heldOutFull.hit1 / heldOutFull.total) + '%', pct(heldOutFull.hit4 / heldOutFull.total) + '%'],
        ],
      ),
      makeTable(
        'Live embedding sweep (optional)',
        ['lexical weight', 'recall@1', 'recall@4'],
        live.rows.length > 0
          ? live.rows.map((row) => [row.weight, `${row.recall1}%`, `${row.recall4}%`])
          : [[live.note, 'n/a', 'n/a']],
      ),
    ],
    findings,
    recommendations: [
      'Report multi-seed means, not a single lucky run; one seed can hide instability.',
      'Keep the ablation table in CI: if a future change makes one channel redundant, the data will show it.',
      'Re-run the held-out corpus whenever tokenization, fusion, or diversity defaults change.',
      'Wire a real embedding endpoint before trusting the 0.4 lexical weight in production; the offline sweep is an ablation, not a deployment recommendation.',
    ],
    verdict:
      stable && ablationLexical && ablationDiversity && heldOutPassed ? 'works' : 'partial',
  };
}
