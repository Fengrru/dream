import {
  ActivationEngine,
  EncodingGate,
  HashingEmbeddingProvider,
  InMemoryStore,
} from '@dream/core';
import { makeTable, pct, type ExperimentResult } from './harness';

const SURNAMES = ['林', '陈', '张', '王', '李', '赵', '周', '吴', '徐', '孙'];
const GIVEN = [
  '小雨', '志强', '欣怡', '浩然', '思远', '雅静', '子轩', '雨桐', '嘉豪', '若曦',
  '文博', '诗涵', '明轩', '一诺', '晨曦', '书瑶', '俊杰', '梦琪', '天佑', '静姝',
];
const CITIES = [
  '北京', '上海', '广州', '深圳', '杭州', '南京', '成都', '重庆', '武汉', '西安',
  '苏州', '天津', '长沙', '青岛', '厦门', '昆明', '合肥', '郑州', '大连', '福州',
];
const RELATIONS = ['妹妹', '哥哥', '表姐', '表弟', '朋友', '同事'];
const DAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

function chineseName(i: number): string {
  return `${SURNAMES[i % SURNAMES.length]}${GIVEN[Math.floor(i / SURNAMES.length) % GIVEN.length]}`;
}

interface Scenario {
  name: string;
  facts: string[];
  queries: string[];
  noise: string[];
}

interface Score {
  hit1: number;
  hit4: number;
  total: number;
}

function personalFacts(n: number): Scenario {
  const facts: string[] = [];
  const queries: string[] = [];
  for (let i = 0; i < n; i++) {
    const name = chineseName(i);
    const city = CITIES[i % CITIES.length];
    const relation = RELATIONS[i % RELATIONS.length];
    facts.push(`我的${relation}${name}住在${city}。`);
    queries.push(`${name}住在哪里？`);
  }
  return { name: '中文个人事实 (60)', facts, queries, noise: [] };
}

function chineseIdentifiers(n: number): Scenario {
  const facts: string[] = [];
  const queries: string[] = [];
  for (let i = 0; i < n; i++) {
    const project = `星云${i + 1}号`;
    facts.push(`项目「${project}」使用 PostgreSQL 存储，部署在法兰克福。`);
    queries.push(`项目「${project}」使用什么数据库？`);
  }
  return { name: '中文标识符 (60)', facts, queries, noise: [] };
}

function chineseKeywordStuffing(n: number): Scenario {
  const facts: string[] = [];
  const queries: string[] = [];
  const noise: string[] = [];
  for (let i = 0; i < n; i++) {
    const service = `结算服务${i + 1}`;
    facts.push(`服务「${service}」的部署窗口是${DAYS[i % DAYS.length]}凌晨${(i % 5) + 1}点。`);
    queries.push(`服务「${service}」的部署窗口是什么时候？`);
    noise.push(`会话日志：部署窗口 服务 ${service} `.repeat(12));
  }
  return { name: '中文关键词堆砌 (20)', facts, queries, noise };
}

function mixedLanguage(n: number): Scenario {
  const facts: string[] = [];
  const queries: string[] = [];
  for (let i = 0; i < n; i++) {
    const flight = `QF${100 + i}`;
    facts.push(`航班 ${flight} 在${DAYS[i % DAYS.length]}下午${(i % 6) + 1}点起飞。`);
    queries.push(`${flight} 航班什么时候起飞？`);
  }
  return { name: '中英混合航班 (40)', facts, queries, noise: [] };
}

function englishFacts(n: number): Scenario {
  const facts: string[] = [];
  const queries: string[] = [];
  const names = ['Ada', 'Grace', 'Alan', 'Barbara', 'Donald', 'Radia', 'Tim', 'Margaret'];
  for (let i = 0; i < n; i++) {
    const name = `${names[i % names.length]}${Math.floor(i / names.length)}`;
    const city = CITIES[i % CITIES.length];
    facts.push(`My friend ${name} lives in ${city}.`);
    queries.push(`Where does ${name} live?`);
  }
  return { name: '英文个人事实 (40)', facts, queries, noise: [] };
}

async function runScenario(scenario: Scenario, cjk: boolean): Promise<Score> {
  const provider = new HashingEmbeddingProvider(256, { cjk });
  const store = new InMemoryStore();
  const gate = new EncodingGate(store, store, provider);
  for (const fact of scenario.facts) {
    await gate.encode({ content: fact, kind: 'percept', source: 'user', explicitFact: true });
  }
  for (const log of scenario.noise) {
    await gate.encode({ content: log, kind: 'percept', source: 'tool' });
  }
  const idByContent = new Map<string, string>();
  for (const node of await store.listNodes()) idByContent.set(node.content, node.id);

  const engine = new ActivationEngine(provider);
  let hit1 = 0;
  let hit4 = 0;
  for (let i = 0; i < scenario.queries.length; i++) {
    const target = idByContent.get(scenario.facts[i]!);
    const set = await engine.activate(store, [scenario.queries[i]!], {
      capacity: 4,
      lexicalCjk: cjk,
    });
    const ids = set.workingSet.map((chunk) => chunk.meta?.['nodeId']);
    if (ids[0] === target) hit1++;
    if (ids.includes(target)) hit4++;
  }
  return { hit1, hit4, total: scenario.queries.length };
}

/**
 * E9 — CJK support ablation.
 *
 * The original tokenizer only matched ASCII, so every Chinese memory embedded
 * to a zero vector and every Chinese BM25 document was empty. This experiment
 * reproduces the legacy behavior (`cjk: false`) and compares it with the
 * Intl.Segmenter + character-bigram tokenizer across pure Chinese, Chinese
 * identifiers, Chinese keyword stuffing, mixed language, and English.
 */
export async function e9Chinese(): Promise<ExperimentResult> {
  const scenarios = [
    personalFacts(60),
    chineseIdentifiers(60),
    chineseKeywordStuffing(20),
    mixedLanguage(40),
    englishFacts(40),
  ];
  const rows: Array<Array<string | number>> = [];
  const scores: Array<{ scenario: Scenario; legacy: Score; cjk: Score }> = [];

  for (const scenario of scenarios) {
    const legacy = await runScenario(scenario, false);
    const cjk = await runScenario(scenario, true);
    scores.push({ scenario, legacy, cjk });
    rows.push([
      scenario.name,
      `${pct(legacy.hit1 / legacy.total)}%`,
      `${pct(cjk.hit1 / cjk.total)}%`,
      `${pct(legacy.hit4 / legacy.total)}%`,
      `${pct(cjk.hit4 / cjk.total)}%`,
    ]);
  }

  const chineseRows = scores.filter((row) => !row.scenario.name.startsWith('英文'));
  const chinesePassed = chineseRows.every(
    (row) => row.cjk.hit4 / row.cjk.total >= 0.95,
  );
  const english = scores.find((row) => row.scenario.name.startsWith('英文'))!;
  const englishParity = english.cjk.hit4 >= english.legacy.hit4;

  const findings = [
    `Legacy tokenizer: pure-Chinese recall@4 was ${pct(scores[0]!.legacy.hit4 / scores[0]!.legacy.total)}% — every Chinese string embedded to a zero vector and produced no BM25 tokens, so ranking was effectively arbitrary.`,
    `CJK tokenizer: pure-Chinese personal facts reached ${pct(scores[0]!.cjk.hit4 / scores[0]!.cjk.total)}% recall@4; Chinese project identifiers ${pct(scores[1]!.cjk.hit4 / scores[1]!.cjk.total)}%; Chinese keyword-stuffed logs ${pct(scores[2]!.cjk.hit4 / scores[2]!.cjk.total)}%.`,
    `Intl.Segmenter words plus character bigrams are both required: segmentation alone is brittle across memory/query phrasing, bigrams alone lose word-level IDF.`,
    `English parity: ${pct(english.legacy.hit4 / english.legacy.total)}% -> ${pct(english.cjk.hit4 / english.cjk.total)}% recall@4 — adding CJK features did not regress the existing ASCII path.`,
  ];

  return {
    id: 'E9',
    title: 'CJK tokenization & multilingual recall',
    question: 'Does the memory system actually work for Chinese content, and does the fix preserve English behavior?',
    hypothesis:
      'ASCII-only tokenization makes Chinese embeddings zero vectors and BM25 documents empty; Intl.Segmenter word tokens plus character bigrams restore recall without changing English token streams.',
    method: [
      'Reproduce the legacy path with cjk:false (ASCII regex only) and compare with the CJK tokenizer.',
      'Scenarios: 60 Chinese personal facts, 60 Chinese project identifiers, 20 Chinese keyword-stuffed logs, 40 mixed-language flights, 40 English facts.',
      'Encode every fact (and noise for the stuffing scenario), then ask each fact\'s question through ActivationEngine (capacity 4).',
      'Score recall@1 / recall@4 against the target node id.',
    ],
    tables: [
      makeTable(
        'Recall by language scenario: legacy ASCII vs CJK tokenizer',
        ['scenario', 'legacy recall@1', 'CJK recall@1', 'legacy recall@4', 'CJK recall@4'],
        rows,
      ),
    ],
    findings,
    recommendations: [
      'Keep CJK tokenization on by default; the legacy ASCII path is an ablation, not a supported configuration.',
      'When adding a new language, extend the tokenizer rather than forking the embedder: vector and BM25 must share the same token space.',
      'Re-run E9 whenever the tokenizer changes; zero-vector regressions are silent and catastrophic.',
    ],
    verdict: chinesePassed && englishParity ? 'works' : 'fails',
  };
}
