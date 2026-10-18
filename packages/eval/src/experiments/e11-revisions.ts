import { createInstance } from '../instance';
import { makeTable, type ExperimentResult } from './harness';

interface RevisionResult {
  attached: number;
  versions: number[];
  hasOldValue: boolean;
  hasNewValue: boolean;
  failedEditLeaked: boolean;
  diffSample: string;
}

async function run(attachRevisions: boolean): Promise<RevisionResult> {
  const { kernel } = await createInstance({ attachRevisions });
  kernel.registerTool('eval-revisions', {
    name: 'apply_patch',
    description: 'apply a deterministic patch',
    parameters: { type: 'object', properties: {} },
    handler: (args) => {
      const { fail } = args as { fail?: boolean };
      if (fail) throw new Error('patch rejected');
      return 'applied';
    },
  });

  await kernel.encodeChunk({
    content: 'The search timeout fix lives in src/search.ts',
    kind: 'percept',
    source: 'user',
    explicitFact: true,
    meta: { artifactKeys: ['src/search.ts'] },
  });

  await kernel.executeTool({
    name: 'apply_patch',
    args: { path: 'src/search.ts', old: 'timeout: 30', new: 'timeout: 10' },
  });
  await kernel.executeTool({
    name: 'apply_patch',
    args: { path: 'src/search.ts', old: 'timeout: 10', new: 'timeout: 5' },
  });
  // Failed edits must not enter the chain.
  await kernel.executeTool({
    name: 'apply_patch',
    args: { path: 'src/search.ts', old: 'timeout: 5', new: 'timeout: 1', fail: true },
  });

  const recall = await kernel.recallContext('which search timeout version was kept?');
  const hit = recall.nodes.find((node) => node.content.includes('search timeout'));
  const revisions = hit?.revisions ?? [];
  return {
    attached: revisions.length,
    versions: revisions.map((revision) => revision.version),
    hasOldValue: revisions.some((revision) => revision.oldContent?.includes('timeout: 30')),
    hasNewValue: revisions.some((revision) => revision.newContent?.includes('timeout: 5')),
    failedEditLeaked: revisions.some((revision) => revision.newContent === 'timeout: 1'),
    diffSample: revisions[0]?.diff?.split('\n').slice(0, 3).join(' / ') ?? '',
  };
}

/**
 * E11 — Artifact revision chain (zero LLM).
 *
 * A summary memory records the decision; the exact before/after text is what a
 * later "which version was finally kept?" question needs. Hy-Memory keeps a
 * diff chain for coding; this experiment generalizes it to any tool call with
 * path/old/new or a unified patch.
 */
export async function e11Revisions(): Promise<ExperimentResult> {
  const baseline = await run(false);
  const enhanced = await run(true);

  const rows: Array<Array<string | number>> = [
    [
      'without revision recall',
      baseline.attached,
      baseline.hasOldValue ? 'yes' : 'no',
      baseline.hasNewValue ? 'yes' : 'no',
      baseline.failedEditLeaked ? 'YES' : 'no',
    ],
    [
      'with revision chain',
      enhanced.attached,
      enhanced.hasOldValue ? 'yes' : 'no',
      enhanced.hasNewValue ? 'yes' : 'no',
      enhanced.failedEditLeaked ? 'YES' : 'no',
    ],
  ];

  const passed =
    baseline.attached === 0 &&
    enhanced.attached === 2 &&
    enhanced.versions.join(',') === '1,2' &&
    enhanced.hasOldValue &&
    enhanced.hasNewValue &&
    !enhanced.failedEditLeaked;

  const findings = [
    `Without revision recall the memory still answered "the fix lives in src/search.ts" but attached ${baseline.attached} exact edits — the version history was invisible to the reasoner.`,
    `With the chain, recall attached ${enhanced.attached} revisions (versions ${enhanced.versions.join(', ')}), including both the 30→10 and 10→5 edits: ${enhanced.diffSample}.`,
    `Failed tool calls were excluded: the rejected 5→1 edit ${enhanced.failedEditLeaked ? 'leaked into the chain' : 'never entered the chain'}; only successful edits are ground truth.`,
    `The chain is deterministic and LLM-free: it is extracted from tool arguments, so it works offline and cannot hallucinate a version.`,
  ];

  return {
    id: 'E11',
    title: 'Artifact revision chain (zero LLM)',
    question: 'Can recall attach the exact before/after history that a summary memory deliberately dropped?',
    hypothesis:
      'Summary memories lose exact values; extracting path/old/new and unified patches from successful tool calls and attaching them to recalled memories recovers the history without any LLM call.',
    method: [
      'Encode a memory referencing src/search.ts, then execute two successful apply_patch edits and one rejected edit.',
      'Recall the memory with revision attachment off/on.',
      'Compare attached revision count, versions, exact old/new values, and whether the failed edit leaked.',
    ],
    tables: [
      makeTable(
        'Revision recall by condition',
        ['condition', 'revisions attached', 'old value 30', 'new value 5', 'failed edit leaked'],
        rows,
      ),
    ],
    findings,
    recommendations: [
      'Record only successful tool calls; a rejected patch is not history.',
      'Keep revisions out of the embedding field and attach them at recall time — they are evidence, not a retrieval signal.',
      'Extend the extractor when a tool has a new deterministic edit shape; do not ask an LLM to reconstruct diffs.',
    ],
    verdict: passed ? 'works' : 'partial',
  };
}
