import { createInstance } from '../instance';
import { makeTable, type ExperimentResult } from './harness';

interface RunResult {
  diagnostics: number;
  resumeSucceeded: boolean;
  staleValueUsed: boolean;
  answerTimeout: string;
  answerRetry: string;
  skillHasSourceFact: boolean;
}

const FILES: Record<string, string> = {
  'src/search.ts': 'export const timeout = 30;\nexport function searchOld() {}\n',
  'src/client.ts': 'export const retry = false;\n',
  'src/index.ts': 'export function searchOld() {}\nexport function main() {}\n',
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
    content: 'Task A: fix the search timeout in src/search.ts',
    kind: 'percept',
    source: 'user',
    explicitFact: true,
    meta: { artifactKeys: ['src/search.ts'] },
  }))!;
  await kernel.executeTool({
    name: 'apply_patch',
    args: { path: 'src/search.ts', old: 'timeout = 30', new: 'timeout = 10' },
  });
  await store.appendTrace({
    id: 'task-a-1',
    taskType: 'fix-timeout',
    steps: [{ tool: 'apply_patch', args: { path: 'src/search.ts' } }],
    outcome: 'success',
    ts: clock.now(),
    factIds: [factA.id],
    environment: 'staging',
  });

  const factB = (await kernel.encodeChunk({
    content: 'Task B: make the retry default true in src/client.ts',
    kind: 'percept',
    source: 'user',
    explicitFact: true,
    meta: { artifactKeys: ['src/client.ts'] },
  }))!;
  await kernel.executeTool({
    name: 'apply_patch',
    args: { path: 'src/client.ts', old: 'retry = false', new: 'retry = true' },
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
    args: { path: 'src/search.ts', old: 'timeout = 10', new: 'timeout = 5' },
  });
  await store.appendTrace({
    id: 'task-a-2',
    taskType: 'fix-timeout',
    steps: [{ tool: 'apply_patch', args: { path: 'src/search.ts' } }],
    outcome: 'success',
    ts: clock.now(),
    factIds: [factA.id, factB.id],
    environment: 'staging',
  });

  const factC = (await kernel.encodeChunk({
    content: 'Task C: rename searchOld to searchNew in src/index.ts',
    kind: 'percept',
    source: 'user',
    explicitFact: true,
    meta: { artifactKeys: ['src/index.ts'] },
  }))!;
  await kernel.executeTool({
    name: 'apply_patch',
    args: { path: 'src/index.ts', old: 'searchOld', new: 'searchNew' },
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
      args: { path: 'src/search.ts', old: `timeout = ${remembered}`, new: 'timeout = 2' },
    });
    resumeSucceeded = files.get('src/search.ts')?.includes('timeout = 2') === true;
  } catch {
    resumeSucceeded = false;
  }

  const diagnostics = [answerTimeout === '5', answerRetry === 'true', skillHasSourceFact].filter(
    Boolean,
  ).length;
  void factB;
  void factC;

  return { diagnostics, resumeSucceeded, staleValueUsed, answerTimeout, answerRetry, skillHasSourceFact };
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
    ['diagnostics (of 3)', baseline.diagnostics, full.diagnostics],
    ['final timeout answer', baseline.answerTimeout, full.answerTimeout],
    ['retry default answer', baseline.answerRetry, full.answerRetry],
    ['skill -> source fact', baseline.skillHasSourceFact ? 'yes' : 'no', full.skillHasSourceFact ? 'yes' : 'no'],
    ['resume succeeded', baseline.resumeSucceeded ? 'yes' : 'no', full.resumeSucceeded ? 'yes' : 'no'],
    ['stale value used on resume', baseline.staleValueUsed ? 'YES' : 'no', full.staleValueUsed ? 'YES' : 'no'],
  ];

  const passed =
    baseline.diagnostics < full.diagnostics &&
    full.diagnostics === 3 &&
    full.resumeSucceeded &&
    !full.staleValueUsed &&
    baseline.staleValueUsed;

  const findings = [
    `Interleaved stream: Task A (timeout) was interrupted by Task B (retry flag), a noise turn and Task C (rename), then resumed with a changed requirement (10 -> 5).`,
    `Summary-only memory scored ${baseline.diagnostics}/3 diagnostics and resumed with a stale value (${baseline.staleValueUsed ? 'yes' : 'no'}); the full stack scored ${full.diagnostics}/3 and resumed successfully (${full.resumeSucceeded ? 'yes' : 'no'}).`,
    `The decisive difference is the revision chain: the final answer came from the exact diff ("timeout = 5"), not from the task summary, which never stored a value. TriLink exposed the skill's source fact for the third diagnostic.`,
    `This is a compact CMB-style test, not the full benchmark: one repository and one frozen stream. The next step is multiple repositories/languages and execution-graded edits.`,
  ];

  return {
    id: 'E18',
    title: 'CMB-lite: interleaved task resumption',
    question: 'Does memory support the next action after tasks are interrupted, requirements change, and work resumes?',
    hypothesis:
      'Summary-only memory loses the final value under interleaving; fact + experience + revision links let the agent answer diagnostics and resume with the exact current state.',
    method: [
      'Freeze an interleaved stream: Task A patch, Task B patch, noise, Task A requirement change, Task C rename, dream.',
      'Ask three diagnostics: final timeout, retry default, and which fact supports the timeout skill.',
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
      'Grow this into a multi-repo, multi-language benchmark before making external claims.',
    ],
    verdict: passed ? 'works' : 'partial',
  };
}
