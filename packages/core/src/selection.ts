/**
 * Working-set selection: diversity + per-kind quotas/reservations.
 *
 * This is deliberately separate from channel activation. Channels decide what
 * is relevant; selection decides which few items enter the capacity-limited
 * focus, and it must be able to say why something was deferred.
 */

import { cosineSimilarity } from './embeddings';
import type { Activated } from './retrieval-types';
import type { MemoryKind } from './types';

export interface SelectionOptions {
  capacity: number;
  diversityThreshold: number;
  diversityKinds: MemoryKind[];
  maxPerKind?: Partial<Record<MemoryKind, number>>;
  reservedKinds?: MemoryKind[];
}

export interface SelectionResult {
  selected: Activated[];
  deferred: Activated[];
}

export function selectActivated(
  ranked: readonly Activated[],
  opts: SelectionOptions,
): SelectionResult {
  const selected: Activated[] = [];
  const deferred: Activated[] = [];
  const selectedIds = new Set<string>();
  const kindCounts = new Map<MemoryKind, number>();
  const underQuota = (kind: MemoryKind): boolean => {
    const limit = opts.maxPerKind?.[kind];
    return limit === undefined || (kindCounts.get(kind) ?? 0) < limit;
  };
  const isDuplicate = (candidate: Activated): boolean =>
    opts.diversityThreshold < 1 &&
    opts.diversityKinds.includes(candidate.node.kind) &&
    selected.some(
      (chosen) =>
        chosen.node.kind === candidate.node.kind &&
        cosineSimilarity(chosen.node.embedding, candidate.node.embedding) >
          opts.diversityThreshold,
    );
  const take = (candidate: Activated): void => {
    selected.push(candidate);
    selectedIds.add(candidate.node.id);
    kindCounts.set(candidate.node.kind, (kindCounts.get(candidate.node.kind) ?? 0) + 1);
  };

  // Reserved kinds get one slot before pure rank order, so a large semantic
  // cluster cannot starve a procedural skill or an episodic event.
  for (const kind of opts.reservedKinds ?? []) {
    if (selected.length >= opts.capacity) break;
    if (!underQuota(kind)) continue;
    const candidate = ranked.find(
      (item) => item.node.kind === kind && !selectedIds.has(item.node.id) && !isDuplicate(item),
    );
    if (candidate) take(candidate);
  }
  for (const candidate of ranked) {
    if (selectedIds.has(candidate.node.id)) continue;
    if (selected.length >= opts.capacity) {
      deferred.push(candidate);
      continue;
    }
    if (!underQuota(candidate.node.kind) || isDuplicate(candidate)) {
      deferred.push(candidate);
      continue;
    }
    take(candidate);
  }

  return { selected, deferred };
}
