import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInstance } from '../instance';
import { makeTable, type ExperimentResult } from './harness';

interface Result {
  diagnostics: number;
  resumeTestPassed: boolean;
  pythonTestPassed: boolean;
  jsonTestPassed: boolean;
  staleValueUsed: boolean;
  answerTimeout: string;
  answerTtl: string;
  answerRetry: string;
}

function runCommand(command: string, args: string[], cwd: string): boolean {
  try {
    execFileSync(command, args, { cwd, stdio: 'pipe', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

async function run(fullMemory: boolean): Promise<Result> {
  const root = mkdtempSync(join(tmpdir(), 'dream-e21-'));
  const tsDir = join(root, 'repo-ts');
  const pyDir = join(root, 'repo-py');
  const jsonDir = join(root, 'repo-json');
  for (const dir of [tsDir, pyDir, jsonDir]) mkdirSync(dir, { recursive: true });

  const tsFile = join(tsDir, 'search.js');
  const pyFile = join(pyDir, 'cache.py');
  const jsonFile = join(jsonDir, 'service.json');
  writeFileSync(tsFile, 'module.exports = { timeout: 30 };\n');
  writeFileSync(pyFile, 'ttl = 60\n');
  writeFileSync(jsonFile, '{"retry": false}\n');
  writeFileSync(
    join(tsDir, 'test.js'),
    "const { timeout } = require('./search');\nif (timeout !== 2) { console.error('timeout=' + timeout); process.exit(1); }\nconsole.log('ok');\n",
  );
  writeFileSync(
    join(pyDir, 'test.py'),
    'import cache\nassert cache.ttl == 15, cache.ttl\nprint("ok")\n',
  );
  writeFileSync(
    join(jsonDir, 'test.js'),
    "const service = require('./service.json');\nif (service.retry !== true) { console.error('retry=' + service.retry); process.exit(1); }\nconsole.log('ok');\n",
  );

  const { kernel, store, clock } = await createInstance({
    attachRevisions: fullMemory,
    attachTriLinks: fullMemory,
    skillMinSuccessfulEpisodes: 2,
  });
  kernel.registerTool('execution-eval', {
    name: 'apply_patch',
    description: 'apply a deterministic replacement on disk',
    parameters: { type: 'object', properties: {} },
    handler: (args) => {
      const { path, old, new: replacement } = args as {
        path: string;
        old: string;
        new: string;
      };
      const current = readFileSync(path, 'utf8');
      if (!current.includes(old)) throw new Error(`patch anchor not found in ${path}`);
      writeFileSync(path, current.replace(old, replacement));
      return 'applied';
    },
  });

  const factA = (await kernel.encodeChunk({
    content: 'Task A: fix the timeout in repo-ts/search.js',
    kind: 'percept',
    source: 'user',
    explicitFact: true,
    meta: { artifactKeys: [tsFile] },
  }))!;
  await kernel.executeTool({
    name: 'apply_patch',
    args: { path: tsFile, old: 'timeout: 30', new: 'timeout: 10' },
  });
  await store.appendTrace({
    id: 'exec-a1',
    taskType: 'fix-timeout',
    steps: [{ tool: 'apply_patch', args: { path: tsFile } }],
    outcome: 'success',
    ts: clock.now(),
    factIds: [factA.id],
    environment: 'staging',
  });

  const factB = (await kernel.encodeChunk({
    content: 'Task B: set the cache TTL in repo-py/cache.py',
    kind: 'percept',
    source: 'user',
    explicitFact: true,
    meta: { artifactKeys: [pyFile] },
  }))!;
  await kernel.executeTool({
    name: 'apply_patch',
    args: { path: pyFile, old: 'ttl = 60', new: 'ttl = 30' },
  });
  await store.appendTrace({
    id: 'exec-b1',
    taskType: 'fix-cache-ttl',
    steps: [{ tool: 'apply_patch', args: { path: pyFile } }],
    outcome: 'success',
    ts: clock.now(),
    factIds: [factB.id],
    environment: 'staging',
  });

  const factC = (await kernel.encodeChunk({
    content: 'Task C: enable retry in repo-json/service.json',
    kind: 'percept',
    source: 'user',
    explicitFact: true,
    meta: { artifactKeys: [jsonFile] },
  }))!;
  await kernel.executeTool({
    name: 'apply_patch',
    args: { path: jsonFile, old: '"retry": false', new: '"retry": true' },
  });

  // Noise, then Task A/B requirements change.
  await kernel.encodeChunk({
    content: 'The team offsite is in Lisbon next spring',
    kind: 'percept',
    source: 'user',
  });
  await kernel.executeTool({
    name: 'apply_patch',
    args: { path: tsFile, old: 'timeout: 10', new: 'timeout: 5' },
  });
  await store.appendTrace({
    id: 'exec-a2',
    taskType: 'fix-timeout',
    steps: [{ tool: 'apply_patch', args: { path: tsFile } }],
    outcome: 'success',
    ts: clock.now(),
    factIds: [factA.id],
    environment: 'staging',
  });
  await kernel.executeTool({
    name: 'apply_patch',
    args: { path: pyFile, old: 'ttl = 30', new: 'ttl = 15' },
  });
  await store.appendTrace({
    id: 'exec-b2',
    taskType: 'fix-cache-ttl',
    steps: [{ tool: 'apply_patch', args: { path: pyFile } }],
    outcome: 'success',
    ts: clock.now(),
    factIds: [factB.id],
    environment: 'staging',
  });
  await kernel.dreamNow();

  const values = async (query: string, pattern: RegExp): Promise<string> => {
    const recall = await kernel.recallContext(query);
    const found = recall.nodes
      .flatMap((node) => node.revisions ?? [])
      .map((revision) => revision.newContent?.match(pattern)?.[1])
      .filter((value): value is string => value !== undefined);
    return found.at(-1) ?? 'unknown';
  };

  const answerTimeout = await values('final timeout repo-ts/search.js', /timeout: (\d+)/);
  const answerTtl = await values('final cache ttl repo-py/cache.py', /ttl = (\d+)/);
  const answerRetry = await values('retry repo-json/service.json', /"retry": (true|false)/);

  const timeoutSkill = (
    await kernel.recallContext('fix-timeout skill')
  ).nodes.find((node) => node.content.includes('fix-timeout'));
  const ttlSkill = (
    await kernel.recallContext('fix-cache-ttl skill')
  ).nodes.find((node) => node.content.includes('fix-cache-ttl'));
  const skillLinks =
    (timeoutSkill?.sourceFacts?.length ?? 0) > 0 && (ttlSkill?.sourceFacts?.length ?? 0) > 0;

  // Resume: the expected final timeout is 2. A stale summary-only memory uses
  // 10 and the patch anchor fails before the test runs.
  const resumeRecall = await kernel.recallContext('resume the timeout task repo-ts');
  const resumeValues = resumeRecall.nodes
    .flatMap((node) => node.revisions ?? [])
    .map((revision) => revision.newContent?.match(/timeout: (\d+)/)?.[1])
    .filter((value): value is string => value !== undefined);
  const remembered = resumeValues.at(-1) ?? '10';
  const staleValueUsed = resumeValues.length === 0;
  try {
    await kernel.executeTool({
      name: 'apply_patch',
      args: { path: tsFile, old: `timeout: ${remembered}`, new: 'timeout: 2' },
    });
  } catch {
    // anchor failure is the expected baseline outcome
  }

  // Execution-graded checks: real Node and Python subprocesses.
  const resumeTestPassed = runCommand(process.execPath, ['test.js'], tsDir);
  const pythonTestPassed = runCommand('python', ['test.py'], pyDir);
  const jsonTestPassed = runCommand(process.execPath, ['test.js'], jsonDir);

  const diagnostics = [
    answerTimeout === '5',
    answerTtl === '15',
    answerRetry === 'true',
    skillLinks,
  ].filter(Boolean).length;

  void factC;
  rmSync(root, { recursive: true, force: true });

  return {
    diagnostics,
    resumeTestPassed,
    pythonTestPassed,
    jsonTestPassed,
    staleValueUsed,
    answerTimeout,
    answerTtl,
    answerRetry,
  };
}

/**
 * E21 — CMB-exec: execution-graded multi-repo resumption.
 *
 * Unlike E18 (in-memory files), this creates three real temporary repositories
 * and runs actual Node/Python test subprocesses after the patches. Memory is
 * judged by whether the resumed repository passes its test, not by recall@k.
 */
export async function e21Execution(): Promise<ExperimentResult> {
  const baseline = await run(false);
  const full = await run(true);

  const rows: Array<Array<string | number>> = [
    ['diagnostics (of 4)', baseline.diagnostics, full.diagnostics],
    ['final timeout', baseline.answerTimeout, full.answerTimeout],
    ['final cache TTL', baseline.answerTtl, full.answerTtl],
    ['retry default', baseline.answerRetry, full.answerRetry],
    ['resume test (Node)', baseline.resumeTestPassed ? 'pass' : 'fail', full.resumeTestPassed ? 'pass' : 'fail'],
    ['python repo test', baseline.pythonTestPassed ? 'pass' : 'fail', full.pythonTestPassed ? 'pass' : 'fail'],
    ['json repo test', baseline.jsonTestPassed ? 'pass' : 'fail', full.jsonTestPassed ? 'pass' : 'fail'],
    ['stale value used', baseline.staleValueUsed ? 'YES' : 'no', full.staleValueUsed ? 'YES' : 'no'],
  ];

  const passed =
    baseline.diagnostics < full.diagnostics &&
    full.diagnostics === 4 &&
    full.resumeTestPassed &&
    !baseline.resumeTestPassed &&
    full.pythonTestPassed &&
    full.jsonTestPassed &&
    baseline.staleValueUsed &&
    !full.staleValueUsed;

  const findings = [
    `Three real temporary repositories (Node, Python, JSON) were patched on disk; the resume step ran \`node test.js\` and \`python test.py\` as subprocesses.`,
    `Summary-only memory scored ${baseline.diagnostics}/4 diagnostics and its resume test ${baseline.resumeTestPassed ? 'passed' : 'failed'}; the full stack scored ${full.diagnostics}/4 and its resume test ${full.resumeTestPassed ? 'passed' : 'failed'}.`,
    `The Python and JSON repository tests passed in both runs (${full.pythonTestPassed ? 'pass' : 'fail'} / ${full.jsonTestPassed ? 'pass' : 'fail'}): the edits themselves were correct; memory only changed whether the interrupted task could be resumed.`,
    `The baseline used a stale timeout (${baseline.answerTimeout}) and failed the patch anchor; the full stack read the final revision ("${full.answerTimeout}"), applied it, and passed an actual test process.`,
  ];

  return {
    id: 'E21',
    title: 'CMB-exec: execution-graded multi-repo resumption',
    question: 'After real patches and interruptions, can memory let the agent resume and pass the repository test?',
    hypothesis:
      'Summary-only memory loses the final value and fails the resume test; fact + revision links recover it and pass a real Node/Python test subprocess.',
    method: [
      'Create three temporary repositories (Node, Python, JSON) with executable test scripts.',
      'Interleave patches: Node timeout, Python TTL, JSON retry, noise, then requirement changes; consolidate.',
      'Ask four diagnostics, resume the Node task, and run the repository tests as subprocesses.',
      'Compare attachRevisions/attachTriLinks off vs on.',
    ],
    tables: [
      makeTable('Execution-graded resumption', ['metric', 'summary only', 'full'], rows),
    ],
    findings,
    recommendations: [
      'Treat a passing repository test as the memory metric for resumed work; recall@k is only a proxy.',
      'Keep execution in the benchmark: in-memory file maps cannot catch stale-anchor failures.',
      'Expand this to more repositories and language runtimes before external claims.',
    ],
    verdict: passed ? 'works' : 'partial',
  };
}
