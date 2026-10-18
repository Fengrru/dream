/**
 * Reciprocal Rank Fusion (RRF).
 *
 * Multi-channel retrieval produces incomparable scores (cosine, BM25, tag
 * overlap). RRF combines their RANKS instead: sum(weight / (k + rank)). A
 * candidate that is decent in several channels outranks one that is perfect in
 * a single channel, which is exactly what the working set should represent.
 */

export interface FusionChannelEntry {
  id: string;
  rank: number;
  weight: number;
}

export interface FusionResult {
  id: string;
  score: number;
  /** Score divided by the best fused score, 0..1. */
  normalized: number;
}

export function reciprocalRankFusion(
  entries: readonly FusionChannelEntry[],
  k = 60,
): FusionResult[] {
  if (entries.length === 0) return [];
  const raw = new Map<string, number>();
  for (const entry of entries) {
    if (entry.rank < 1) continue;
    raw.set(entry.id, (raw.get(entry.id) ?? 0) + entry.weight / (k + entry.rank));
  }
  const max = Math.max(...raw.values());
  return [...raw.entries()]
    .map(([id, score]) => ({
      id,
      score,
      normalized: max > 0 ? score / max : 0,
    }))
    .sort((a, b) => b.score - a.score);
}
