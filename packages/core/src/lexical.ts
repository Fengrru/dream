/**
 * Deterministic lexical retrieval channel (BM25).
 *
 * Feature-hashing embeddings capture token presence but not term rarity or
 * document length. That is exactly the failure mode where a long, noisy
 * document repeating the query words outranks a short precise fact, and where
 * rare identifiers collide in the hashed space. BM25 adds the two missing
 * signals (IDF and length normalization) with zero dependencies, then the
 * activation engine fuses it with the vector channels.
 *
 * The design is borrowed from Hy-Memory's hybrid reader: vector candidates
 * plus a keyword/BM25 channel, fused before ranking.
 */

import { lexicalTokens } from './tokenizer';

export { lexicalTokens };

export interface BM25Document {
  id: string;
  /** Raw text; ignored when pre-tokenized `tokens` are supplied. */
  text?: string;
  /** Pre-tokenized content (allows callers to cache tokenization per node). */
  tokens?: string[];
}

export interface BM25Options {
  /** Term-frequency saturation. */
  k1?: number;
  /** Length-normalization strength (0 = none, 1 = full). */
  b?: number;
  /** Include CJK word/character-bigram tokens (default true). */
  cjk?: boolean;
}

export interface BM25Hit {
  id: string;
  /** Raw BM25 score (unbounded). */
  score: number;
  /** Score divided by the best score for this query, 0..1. */
  normalized: number;
  /** Fraction of distinct query tokens present in the document, 0..1. */
  matchedRatio: number;
}

/**
 * Rank documents for a query with BM25. Scores are normalized per query so the
 * activation engine can fuse them with cosine activations on a common scale.
 */
export function bm25Rank(
  docs: readonly BM25Document[],
  query: string,
  options: BM25Options = {},
): BM25Hit[] {
  const k1 = options.k1 ?? 1.2;
  const b = options.b ?? 0.75;
  const queryTokens = [...new Set(lexicalTokens(query, { cjk: options.cjk }))];
  if (docs.length === 0) return [];
  if (queryTokens.length === 0) {
    return docs.map((doc) => ({ id: doc.id, score: 0, normalized: 0, matchedRatio: 0 }));
  }

  const tokenized = docs.map((doc) => doc.tokens ?? lexicalTokens(doc.text ?? ''));
  const totalLength = tokenized.reduce((sum, tokens) => sum + tokens.length, 0);
  const avgLength = totalLength > 0 ? totalLength / docs.length : 1;

  const documentFrequency = new Map<string, number>();
  for (const tokens of tokenized) {
    const seen = new Set(tokens);
    for (const queryToken of queryTokens) {
      if (seen.has(queryToken)) {
        documentFrequency.set(queryToken, (documentFrequency.get(queryToken) ?? 0) + 1);
      }
    }
  }
  const idf = new Map<string, number>();
  for (const token of queryTokens) {
    const df = documentFrequency.get(token) ?? 0;
    idf.set(token, Math.log(1 + (docs.length - df + 0.5) / (df + 0.5)));
  }

  const hits: BM25Hit[] = docs.map((doc, index) => {
    const tokens = tokenized[index]!;
    const termFrequency = new Map<string, number>();
    for (const token of tokens) termFrequency.set(token, (termFrequency.get(token) ?? 0) + 1);

    let score = 0;
    let matched = 0;
    for (const queryToken of queryTokens) {
      const tf = termFrequency.get(queryToken);
      if (!tf) continue;
      matched++;
      const lengthNorm = 1 - b + (b * tokens.length) / avgLength;
      score += (idf.get(queryToken) ?? 0) * ((tf * (k1 + 1)) / (tf + k1 * lengthNorm));
    }
    return {
      id: doc.id,
      score,
      normalized: 0,
      matchedRatio: matched / queryTokens.length,
    };
  });

  const max = Math.max(...hits.map((hit) => hit.score));
  for (const hit of hits) hit.normalized = max > 0 ? hit.score / max : 0;
  return hits;
}
