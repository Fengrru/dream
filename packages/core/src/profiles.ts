/**
 * Retrieval profiles: named bundles of channel defaults.
 *
 * The individual knobs are still available, but a profile makes the trade-off
 * legible: `offline` keeps the cheapest deterministic channels, `balanced` is
 * the default personal-agent setting, and `deep` turns on rank fusion, typed
 * priors and a reserved procedural slot.
 */

import type { Association, MemoryKind } from './types';

export type RetrievalProfileName = 'offline' | 'balanced' | 'deep';

export interface RetrievalProfileOptions {
  lexicalWeight: number;
  tagWeight: number;
  episodeWeight: number;
  fusion: 'interpolate' | 'rrf';
  reservedKinds: MemoryKind[];
  maxPerKind?: Partial<Record<MemoryKind, number>>;
  relationPriors?: Partial<Record<Association['type'], number>>;
  degreeNormalize: boolean;
}

export const RETRIEVAL_PROFILES: Record<RetrievalProfileName, RetrievalProfileOptions> = {
  offline: {
    lexicalWeight: 0.4,
    tagWeight: 0.1,
    episodeWeight: 0,
    fusion: 'interpolate',
    reservedKinds: [],
    degreeNormalize: false,
  },
  balanced: {
    lexicalWeight: 0.4,
    tagWeight: 0.15,
    episodeWeight: 0.1,
    fusion: 'interpolate',
    reservedKinds: [],
    degreeNormalize: false,
  },
  deep: {
    lexicalWeight: 0.4,
    tagWeight: 0.2,
    episodeWeight: 0.2,
    fusion: 'rrf',
    reservedKinds: ['procedural'],
    maxPerKind: { semantic: 3 },
    relationPriors: {
      causal: 0.9,
      elaborates: 0.85,
      temporal: 0.7,
      contrast: 0.7,
      entity: 0.6,
      similar: 0.5,
    },
    degreeNormalize: true,
  },
};

export function resolveRetrievalProfile(
  name: RetrievalProfileName,
  overrides: Partial<RetrievalProfileOptions> = {},
): RetrievalProfileOptions {
  return { ...RETRIEVAL_PROFILES[name], ...overrides };
}
