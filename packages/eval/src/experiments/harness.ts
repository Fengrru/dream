import type { EmbeddingProvider } from '@dream/core';

/**
 * Shared harness for the Dream experiment suite. Every experiment is
 * deterministic (seeded corpus, FakeClock) and reports structured results so
 * the runner can render a research-style report.
 */

export interface ExperimentTable {
  title: string;
  columns: string[];
  rows: Array<Array<string | number>>;
}

export type Verdict = 'works' | 'partial' | 'fails';

export interface ExperimentResult {
  id: string;
  title: string;
  question: string;
  hypothesis: string;
  method: string[];
  tables: ExperimentTable[];
  findings: string[];
  recommendations: string[];
  verdict: Verdict;
}

/** Synthetic but realistic personal-fact corpus with a unique key per fact. */
export interface FactCorpus {
  facts: string[];
  queries: string[];
  noise: string[];
}

const ADJECTIVES = [
  'youngest', 'eldest', 'tall', 'quiet', 'clever', 'busy', 'kind', 'shy',
  'bold', 'witty', 'calm', 'lively', 'stern', 'gentle', 'sharp', 'loyal',
  'brave', 'merry', 'noble', 'swift',
];
const RELATIONS = [
  'sister', 'brother', 'cousin', 'nephew', 'niece', 'uncle', 'aunt',
  'father', 'mother', 'friend',
];
const NAMES = [
  'Ada', 'Grace', 'Alan', 'Edsger', 'Barbara', 'Donald', 'Radia', 'Leslie',
  'Tim', 'Frances', 'Linus', 'Margaret', 'Dennis', 'Ken', 'Joan', 'Anita',
  'John', 'Mary', 'Peter', 'Jean',
];

/**
 * `n` unique facts sharing one syntactic template — the hardest case for a
 * bag-of-features embedder, because the scaffold tokens dominate and only a
 * single adjective+relation bigram distinguishes each fact.
 */
export function buildFactCorpus(n: number): FactCorpus {
  const facts: string[] = [];
  const queries: string[] = [];
  const noise: string[] = [];
  for (let i = 0; i < n; i++) {
    const adj = ADJECTIVES[i % ADJECTIVES.length]!;
    const rel = RELATIONS[Math.floor(i / ADJECTIVES.length) % RELATIONS.length]!;
    const name = NAMES[i % NAMES.length]!;
    facts.push(`My ${adj} ${rel}'s name is ${name}.`);
    queries.push(`What is my ${adj} ${rel}'s name?`);
    noise.push(`weekly sync note ${i}: shipped the parser fix, reviewed two pull requests, moved the retro to thursday`);
  }
  return { facts, queries, noise };
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function pct(fraction: number): number {
  return Math.round(fraction * 1000) / 10;
}

export function makeTable(title: string, columns: string[], rows: Array<Array<string | number>>): ExperimentTable {
  return { title, columns, rows };
}
