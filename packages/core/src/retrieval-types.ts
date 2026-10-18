import type { MemoryNode, RelationStep } from './types';

/** A node activated by one or more retrieval channels. */
export interface Activated {
  node: MemoryNode;
  activation: number;
  /** Typed path from a seed that produced this activation (strongest path). */
  path?: RelationStep[];
}
