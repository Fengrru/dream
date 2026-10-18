import { describe, expect, it } from 'vitest';
import { reciprocalRankFusion } from '../src/fusion';

describe('Reciprocal rank fusion', () => {
  it('prefers a candidate that ranks well in several channels', () => {
    const fused = reciprocalRankFusion([
      { id: 'a', rank: 1, weight: 0.4 },
      { id: 'b', rank: 2, weight: 0.4 },
      { id: 'b', rank: 1, weight: 0.25 },
      { id: 'c', rank: 2, weight: 0.25 },
    ]);
    expect(fused.map((entry) => entry.id)).toEqual(['b', 'a', 'c']);
    expect(fused[0]!.normalized).toBe(1);
    expect(fused[0]!.score).toBeGreaterThan(fused[1]!.score);
  });

  it('returns an empty result for no channel entries', () => {
    expect(reciprocalRankFusion([])).toEqual([]);
  });
});
