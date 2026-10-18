import { createInstance } from '../instance';
import { makeTable, type ExperimentResult } from './harness';

interface RunResult {
  diagnostics: number;
  resumeSucceeded: boolean;
  staleValueUsed: boolean;
  answerTimeout: string;
  answerRetry: string;
  answerCache: string;
  skillHasSourceFact: boolean;
}

const FILES: Record<string, string> = {
  'repo-a/src/search.ts': 'export const timeout = 30;\nexport function searchOld() {}\n',
  'repo-a/src/client.ts': 'export const retry = false;\n',
  'repo-a/src/index.ts': 'export function searchOld() {}\nexport function main() {}\n',
  'repo-b/service/cache.py': 'ttl = 60\nretry = 2\n',
};

/**
 * Frozen interleaved stream. Task A is interrupted by Task B, a noise turn,
 * then resumed with a requirement change; Task C interleaves; Task B changes
 * again. This is the shape CMB measures: memory must support the NEXT action,
 * not just recall text.
 */
async function run(fullMemory: boolean): Promise<RunResult> {
  const { kernel, store, clock } = await createInstance({
    attachRevisions: fullMemory,
    attachTriLinks: fullMemory,
    skillMinSuccessfulEpisodes: 2,
  });
  const files = new Map(Object.entries(FILES));

  kernel.registerTool('interleaved-eval', {
    name: 'apply_patch',
    description: 'apply a deterministic replacement',
    parameters: { type: 'object', properties: {} },
    handler: (args) => {
      const { path, old, new: replacement } = args as {
        path: string;
        old: string;
        new: string;
      };
      const current = files.get(path);
      if (current === undefined) throw new Error(`missing file ${path}`);
      if (!current.includes(old)) throw new Error(`patch anchor not found in ${path}`);
      files.set(path, current.replace(old, replacement));
      return 'applied';
    },
  });

  const factA = (await kernel.encodeChunk({
    content: 'Task A: fix the search timeout in repo-a/src/search.ts',
    kind: 'percept',
    source: 'user',
    explicitFact: true,
    meta: { artifactKeys: ['repo-a/src/search.ts'] },
  }))!;
  await kernel.executeTool({
    name: 'apply_patch',
    args: { path: 'repo-a/src/search.ts', old: 'timeout = 30', new: 'timeout = 10' },
  });
  await store.appendTrace({
    id: 'task-a-1',
    taskType: 'fix-timeout',
    steps: [{ tool: 'apply_patch', args: { path: 'repo-a/src/search.ts' } }],
    outcome: 'success',
    ts: clock.now(),
    factIds: [factA.id],
    environment: 'staging',
  });

  const factB = (await kernel.encodeChunk({
    content: 'Task B: make the retry default true in repo-a/src/client.ts',
    kind: 'percept',
    source: 'user',
    explicitFact: true,
    meta: { artifactKeys: ['repo-a/src/client.ts'] },
  }))!;
  await kernel.executeTool({
    name: 'apply_patch',
    args: { path: 'repo-a/src/client.ts', old: 'retry = false', new: 'retry = true' },
  });

  // Noise turn: an unrelated memory while both tasks are unfinished.
  await kernel.encodeChunk({
    content: 'The team offsite is in Lisbon next spring',
    kind: 'percept',
    source: 'user',
  });

  // Task A resumes with a changed requirement (10 -> 5), then Task C appears.
  await kernel.executeTool({
    name: 'apply_patch',
    args: { path: 'repo-a/src/search.ts', old: 'timeout = 10', new: 'timeout = 5' },
  });
  await store.appendTrace({
    id: 'task-a-2',
    taskType: 'fix-timeout',
    steps: [{ tool: 'apply_patch', args: { path: 'repo-a/src/search.ts' } }],
    outcome: 'success',
    ts: clock.now(),
    factIds: [factA.id, factB.id],
    environment: 'staging',
  });

  const factC = (await kernel.encodeChunk({
    content: 'Task C：把 repo-a/src/index.ts 里的 searchOld 重命名为 searchNew',
    kind: 'percept',
    source: 'user',
    explicitFact: true,
    meta: { artifactKeys: ['repo-a/src/index.ts'] },
  }))!;
  await kernel.executeTool({
    name: 'apply_patch',
    args: { path: 'repo-a/src/index.ts', old: 'searchOld', new: 'searchNew' },
  });

  // Task D lives in a different repository and language (Python). It changes
  // the cache TTL twice; the final value is 15, not the first 30.
  const factD = (await kernel.encodeChunk({
    content: 'Task D：调整 repo-b/service/cache.py 的 cache TTL',
    kind: 'percept',
    source: 'user',
    explicitFact: true,
    meta: { artifactKeys: ['repo-b/service/cache.py'] },
  }))!;
  await kernel.executeTool({
    name: 'apply_patch',
    args: { path: 'repo-b/service/cache.py', old: 'ttl = 60', new: 'ttl = 30' },
  });
  await kernel.executeTool({
    name: 'apply_patch',
    args: { path: 'repo-b/service/cache.py', old: 'ttl = 30', new: 'ttl = 15' },
  });

  await kernel.dreamNow();

  const timeoutRecall = await kernel.recallContext('what timeout value was finally kept?');
  const timeoutRevisions = timeoutRecall.nodes.flatMap((node) => node.revisions ?? []);
  const timeoutValues = timeoutRevisions
    .map((revision) => revision.newContent?.match(/timeout = (\d+)/)?.[1])
    .filter((value): value is string => value !== undefined);
  const answerTimeout = timeoutValues.at(-1) ?? 'unknown';

  const retryRecall = await kernel.recallContext('what is the retry default?');
  const retryValues = retryRecall.nodes
    .flatMap((node) => node.revisions ?? [])
    .map((revision) => revision.newContent?.match(/retry = (true|false)/)?.[1])
    .filter((value): value is string => value !== undefined);
  const answerRetry = retryValues.at(-1) ?? 'unknown';

  const cacheRecall = await kernel.recallContext('Task D cache TTL repo-b/service/cache.py');
  const cacheValues = cacheRecall.nodes
    .flatMap((node) => node.revisions ?? [])
    .map((revision) => revision.newContent?.match(/ttl = (\d+)/)?.[1])
    .filter((value): value is string => value !== undefined);
  const answerCache = cacheValues.at(-1) ?? 'unknown';

  const skillRecall = await kernel.recallContext('fix-timeout skill');
  const skill = skillRecall.nodes.find((node) => node.content.includes('fix-timeout'));
  const skillHasSourceFact = (skill?.sourceFacts?.length ?? 0) > 0;

  // Resume the interrupted task: the final timeout is 5. A summary-only
  // memory falls back to its stale 10 and the patch anchor fails.
  const resumeRecall = await kernel.recallContext('resume the search timeout task');
  const resumeValues = resumeRecall.nodes
    .flatMap((node) => node.revisions ?? [])
    .map((revision) => revision.newContent?.match(/timeout = (\d+)/)?.[1])
    .filter((value): value is string => value !== undefined);
  const remembered = resumeValues.at(-1) ?? '10';
  const staleValueUsed = resumeValues.length === 0;
  let resumeSucceeded = false;
  try {
    await kernel.executeTool({
      name: 'apply_patch',
      args: { path: 'repo-a/src/search.ts', old: `timeout = ${remembered}`, new: 'timeout = 2' },
    });
    resumeSucceeded = files.get('repo-a/src/search.ts')?.includes('timeout = 2') === true;
  } catch {
    resumeSucceeded = false;
  }

  const diagnostics = [
    answerTimeout === '5',
    answerRetry === 'true',
    answerCache === '15',
    skillHasSourceFact,
  ].filter(Boolean).length;
  void factB;
  void factC;
  void factD;

  return {
    diagnostics,
    resumeSucceeded,
    staleValueUsed,
    answerTimeout,
    answerRetry,
    answerCache,
    skillHasSourceFact,
  };
}

/**
 * E18 — CMB-lite: interleaved task resumption.
 *
 * CMB (Hy-Memory's coding memory benchmark) freezes an interleaved task stream
 * and measures whether memory supports the next action. This is a compact,
 * deterministic version: three tasks interrupt each other, requirements change,
 * and the agent must answer diagnostics and resume Task A with the FINAL value.
 */
export async function e18Interleaved(): Promise<ExperimentResult> {
  const baseline = await run(false);
  const full = await run(true);

  const rows: Array<Array<string | number>> = [
    ['diagnostics (of 4)', baseline.diagnostics, full.diagnostics],
    ['final timeout answer', baseline.answerTimeout, full.answerTimeout],
    ['retry default answer', baseline.answerRetry, full.answerRetry],
    ['final cache TTL (Python repo)', baseline.answerCache, full.answerCache],
    ['skill -> source fact', baseline.skillHasSourceFact ? 'yes' : 'no', full.skillHasSourceFact ? 'yes' : 'no'],
    ['resume succeeded', baseline.resumeSucceeded ? 'yes' : 'no', full.resumeSucceeded ? 'yes' : 'no'],
    ['stale value used on resume', baseline.staleValueUsed ? 'YES' : 'no', full.staleValueUsed ? 'YES' : 'no'],
  ];

  const passed =
    baseline.diagnostics < full.diagnostics &&
    full.diagnostics === 4 &&
    full.resumeSucceeded &&
    !full.staleValueUsed &&
    baseline.staleValueUsed;

  const findings = [
    `Interleaved stream: Task A (TypeScript timeout) was interrupted by Task B (retry flag), a noise turn, Task C (Chinese rename instruction) and Task D (Python cache TTL), then resumed with a changed requirement (10 -> 5).`,
    `Summary-only memory scored ${baseline.diagnostics}/4 diagnostics and resumed with a stale value (${baseline.staleValueUsed ? 'yes' : 'no'}); the full stack scored ${full.diagnostics}/4 and resumed successfully (${full.resumeSucceeded ? 'yes' : 'no'}).`,
    `The decisive difference is the revision chain: final answers came from exact diffs ("timeout = 5", "ttl = 15"), not from task summaries, which never stored a value. TriLink exposed the skill's source fact for the fourth diagnostic.`,
    `This is a compact CMB-style test: two repositories, TypeScript + Python, Chinese and English instructions, one frozen stream; not the full multi-task benchmark. The next step is more repositories/languages and execution-graded edits beyond deterministic patches.`,
  ];

  return {
    id: 'E18',
    title: 'CMB-lite: multi-repo interleaved resumption',
    question: 'Does memory support the next action after tasks are interrupted, requirements change, and work resumes?',
    hypothesis:
      'Summary-only memory loses the final value under interleaving; fact + experience + revision links let the agent answer diagnostics and resume with the exact current state.',
    method: [
      'Freeze an interleaved stream across repo-a (TypeScript) and repo-b (Python): Task A patch, Task B patch, noise, Task A requirement change, Task C Chinese rename, Task D cache TTL, dream.',
      'Ask four diagnostics: final timeout, retry default, final cache TTL, and which fact supports the timeout skill.',
      'Resume Task A with a further edit; a stale remembered value fails the patch anchor, the exact final value succeeds.',
      'Run the same stream with attachRevisions/attachTriLinks off vs on.',
    ],
    tables: [
      makeTable(
        'Interleaved resumption by memory condition',
        ['metric', 'summary only', 'full (fact + experience + revision)'],
        rows,
      ),
    ],
    findings,
    recommendations: [
      'Evaluate memory by the next action, not only recall@k; a stale value can look like a correct recall.',
      'Keep the revision chain attached to task facts; the final value is often absent from every summary.',
      'Two repositories are illustrative, not statistically representative; grow to more repos/languages and execution-graded edits before external claims.',
    ],
    verdict: passed ? 'works' : 'partial',
  };
}
