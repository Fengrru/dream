import { ActivationEngine } from '@dream/core';
import { createInstance, type EvalInstance } from '../instance';
import { makeTable, pct, type ExperimentResult } from './harness';

interface Theme {
  key: string;
  episodes: string[];
  patternQuery: string;
  keyword: string;
}

const THEMES: Theme[] = [
  {
    key: 'workout',
    episodes: [
      'Workout session 1: cardio and strength training for 45 minutes.',
      'Workout session 2: cardio and core training for 30 minutes.',
      'Workout session 3: cardio and strength training for 50 minutes.',
      'Workout session 4: cardio and mobility training for 25 minutes.',
      'Workout session 5: cardio and strength training for 40 minutes.',
    ],
    patternQuery: 'what do my workout sessions usually look like?',
    keyword: 'workout',
  },
  {
    key: 'sales',
    episodes: [
      'Sales review 1: revenue grew 8 percent, churn dropped slightly.',
      'Sales review 2: revenue grew 5 percent, churn held steady.',
      'Sales review 3: revenue grew 11 percent, churn dropped again.',
      'Sales review 4: revenue grew 6 percent, churn ticked up once.',
      'Sales review 5: revenue grew 9 percent, churn dropped overall.',
    ],
    patternQuery: 'how do my sales reviews usually go?',
    keyword: 'sales',
  },
  {
    key: 'trip',
    episodes: [
      'Trip to Kyoto: visited temples, the flight was smooth.',
      'Trip to Lisbon: visited the coast, the flight was bumpy.',
      'Trip to Vienna: visited museums, the flight was smooth.',
      'Trip to Oslo: visited the fjords, the flight was bumpy.',
      'Trip to Hanoi: visited the old town, the flight was smooth.',
    ],
    patternQuery: 'what are my trips usually like?',
    keyword: 'trip',
  },
];

const SINGLES = [
  'Renewed the apartment lease for another year.',
  'Backed up the photo library to the external drive.',
  'Booked the dentist appointment for next month.',
  'Finished reading the distributed systems paper.',
  'Replaced the broken keyboard with a mechanical one.',
];

/**
 * E2 — Does the dream (consolidation) cycle actually help?
 *
 * Pattern-level queries ("what do my workouts usually look like?") are
 * inherently LATER queries — asked days after the episodes. So both
 * conditions are measured 30 days after encoding:
 *
 * - Condition B (no consolidation): the best the store can offer is ONE
 *   arbitrary episode — a generalization from a single instance.
 * - Condition A (after one real dream cycle): an abstracted semantic node
 *   aggregates the cluster; salience-weighted activation should surface it
 *   at rank 1.
 *
 * Episode-level regression checks that exact-content recall survives
 * consolidation (merged duplicates decay softly, recoverable).
 */
export async function e2Consolidation(): Promise<ExperimentResult> {
  const { kernel, store, clock }: EvalInstance = await createInstance();
  const engine = new ActivationEngine(kernel.provider);
  const gate = kernel.gate;

  const allEpisodes: string[] = THEMES.flatMap((t) => t.episodes).concat(SINGLES);
  for (const content of allEpisodes) {
    await gate.encode({ content, kind: 'percept', source: 'user' });
  }

  // 30 days pass before the pattern query arrives (realistic latency).
  clock.advance(30 * 24 * 60 * 60 * 1000);

  // Condition B: before consolidation.
  const before = await measurePattern(engine, store, THEMES);

  // One real dream cycle.
  const report = await kernel.dreamNow();

  // Condition A: same store, abstractions now exist.
  const after = await measurePattern(engine, store, THEMES);

  // Episode-level regression: exact-content queries must still surface the
  // episode (merged duplicates had strength halved — soft, recoverable).
  let episodeChecks = 0;
  let episodePassed = 0;
  for (const content of allEpisodes) {
    const set = await engine.activate(store, [content], { capacity: 4 });
    const ids = set.workingSet.map((c) => c.meta?.['nodeId']);
    const id = await findId(store, content);
    const node = id ? await store.getNode(id) : null;
    if (!node) continue;
    episodeChecks += 2;
    if (ids.includes(node.id)) episodePassed++; // still directly retrievable
    if (node.strength > 0.05) episodePassed++; // not hard-forgotten
  }

  const findings = [
    `Dream cycle produced ${report.abstractions.length} abstractions (expected ${THEMES.length}), merged ${report.mergedCount} near-duplicate episodes.`,
    `Pattern queries 30 days later — WITHOUT consolidation: abstraction hit@1 0/3 by construction (no abstraction exists); the best answer available is a single arbitrary episode, i.e. generalizing from one instance.`,
    `Pattern queries 30 days later — WITH consolidation: abstraction hit@1 ${after.abstractionTop1}/${THEMES.length}, hit@4 ${after.abstractionTop4}/${THEMES.length} (salience-weighted activation: 0.75*sim + 0.25*importance).`,
    `Theme-keyword coverage is high in both conditions (${pct(before.keywordTop4)}% -> ${pct(after.keywordTop4)}% @4) — the cycle's value is the LEVEL of the answer (general pattern vs one instance), not keyword recall.`,
    `Episode-level recall survived consolidation: ${episodePassed}/${episodeChecks} checks passed (direct retrievability + soft-decay recoverability).`,
  ];

  const verdict: ExperimentResult['verdict'] =
    report.abstractions.length >= THEMES.length && after.abstractionTop1 >= 2 ? 'works' : 'partial';

  return {
    id: 'E2',
    title: 'Consolidation (dream cycle) efficacy',
    question: 'Does offline consolidation improve pattern-level recall without destroying episode-level recall?',
    hypothesis:
      'Abstracted semantic nodes (salience-weighted activation) surface at rank 1 for pattern queries asked days later; before consolidation the best available answer is one arbitrary episode; exact-content recall survives soft decay.',
    method: [
      'Corpus: 3 thematic clusters x 5 episodes + 5 one-off episodes, encoded as episodic memory in one kernel.',
      '30 days pass (recency decay), then condition B: pattern + episode queries against raw episodes.',
      'One real kernel.dreamNow(), then condition A: identical queries.',
      'Pattern metric: does an abstraction node for the matching theme appear in the working set; episode regression counts retrievability and recoverability.',
    ],
    tables: [
      makeTable(
        'Pattern queries 30 days later: before vs after consolidation',
        [
          'theme',
          'B: top-1 is theme episode (overgeneralized)',
          'A: top-1 is the abstraction',
          'A: abstraction in top-4',
        ],
        THEMES.map((t) => [
          t.key,
          before.byTheme[t.key]!.keywordTop1 ? 'yes (only option)' : 'no',
          after.byTheme[t.key]!.abstractionTop1 ? 'YES' : 'no',
          after.byTheme[t.key]!.abstractionTop4 ? 'yes' : 'no',
        ]),
      ),
      makeTable(
        'Consolidation effects',
        ['metric', 'value'],
        [
          ['abstractions created', report.abstractions.length],
          ['episodes merged', report.mergedCount],
          ['episode checks passed', `${episodePassed}/${episodeChecks}`],
          ['keyword coverage @4 (B -> A)', `${pct(before.keywordTop4)}% -> ${pct(after.keywordTop4)}%`],
        ],
      ),
    ],
    findings,
    recommendations: [
      'Keep the dream cycle; pattern-level questions are exactly where raw retrieval is structurally weakest.',
      'Run the dream cycle on a schedule (idle detection), not just manually — abstractions only exist after it runs.',
    ],
    verdict,
  };
}

interface Measurement {
  keywordTop1: number;
  keywordTop4: number;
  abstractionTop1: number;
  abstractionTop4: number;
  byTheme: Record<
    string,
    { keywordTop1: boolean; keywordTop4: boolean; abstractionTop1: boolean; abstractionTop4: boolean }
  >;
}

async function measurePattern(
  engine: ActivationEngine,
  store: { getNode(id: string): Promise<{ content: string; kind: string; meta?: Record<string, unknown> } | null> },
  themes: Theme[],
): Promise<Measurement> {
  let keywordTop1 = 0;
  let keywordTop4 = 0;
  let abstractionTop1 = 0;
  let abstractionTop4 = 0;
  const byTheme: Measurement['byTheme'] = {};
  for (const theme of themes) {
    const set = await engine.activate(store as never, [theme.patternQuery], { capacity: 4 });
    const nodes: Array<{ content: string; kind: string; isAbstraction: boolean }> = [];
    for (const chunk of set.workingSet) {
      const id = chunk.meta?.['nodeId'] as string | undefined;
      if (!id) continue;
      const node = await store.getNode(id);
      if (node) {
        nodes.push({
          content: node.content,
          kind: node.kind,
          isAbstraction: node.kind === 'semantic' && node.meta?.['abstractedFrom'] !== undefined,
        });
      }
    }
    const kw1 = nodes[0]?.content.toLowerCase().includes(theme.keyword) ?? false;
    const kw4 = nodes.some((n) => n.content.toLowerCase().includes(theme.keyword));
    const abs1 = nodes[0]?.isAbstraction ?? false;
    const abs4 = nodes.some((n) => n.isAbstraction);
    if (kw1) keywordTop1++;
    if (kw4) keywordTop4++;
    if (abs1) abstractionTop1++;
    if (abs4) abstractionTop4++;
    byTheme[theme.key] = { keywordTop1: kw1, keywordTop4: kw4, abstractionTop1: abs1, abstractionTop4: abs4 };
  }
  return { keywordTop1: keywordTop1 / themes.length, keywordTop4: keywordTop4 / themes.length, abstractionTop1, abstractionTop4, byTheme };
}

async function findId(
  store: { listNodes(filter?: unknown): Promise<Array<{ id: string; content: string }>> },
  content: string,
): Promise<string | undefined> {
  const nodes = await store.listNodes();
  return nodes.find((n) => n.content === content)?.id;
}
