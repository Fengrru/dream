import { describe, expect, it } from 'vitest';
import { RETRIEVAL_PROFILES, resolveRetrievalProfile } from '../src/profiles';

describe('Retrieval profiles', () => {
  it('balanced matches the shipped kernel defaults', () => {
    expect(RETRIEVAL_PROFILES.balanced).toMatchObject({
      lexicalWeight: 0.4,
      tagWeight: 0.15,
      episodeWeight: 0.1,
      fusion: 'interpolate',
      reservedKinds: [],
      degreeNormalize: false,
    });
  });

  it('deep enables rank fusion, typed priors and a reserved skill slot', () => {
    const deep = RETRIEVAL_PROFILES.deep;
    expect(deep.fusion).toBe('rrf');
    expect(deep.reservedKinds).toEqual(['procedural']);
    expect(deep.relationPriors?.causal).toBe(0.9);
    expect(deep.degreeNormalize).toBe(true);
  });

  it('explicit overrides win over the profile', () => {
    const resolved = resolveRetrievalProfile('deep', {
      fusion: 'interpolate',
      reservedKinds: [],
    });
    expect(resolved.fusion).toBe('interpolate');
    expect(resolved.reservedKinds).toEqual([]);
    expect(resolved.relationPriors?.causal).toBe(0.9);
  });
});
