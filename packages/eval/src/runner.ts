import {
  contradictionUpdate,
  crossSessionRecall,
  learningCurve,
  memoryPoisoning,
  type SuiteResult,
} from './suites';

export async function runAllSuites(): Promise<SuiteResult[]> {
  return [
    await crossSessionRecall(),
    await contradictionUpdate(),
    await learningCurve(),
    await memoryPoisoning(),
  ];
}

export function renderMarkdown(results: SuiteResult[]): string {
  const lines: string[] = ['# Dream eval report', ''];
  const passCount = results.filter((r) => r.passed).length;
  lines.push(`**${passCount}/${results.length} suites passed.**`, '');
  for (const r of results) {
    lines.push(`## ${r.passed ? 'PASS' : 'FAIL'} — ${r.name}`, '');
    lines.push(`_${r.description}_`, '');
    lines.push('| metric | value |', '| --- | --- |');
    for (const [k, v] of Object.entries(r.metrics)) {
      lines.push(`| ${k} | \`${String(v)}\` |`);
    }
    if (r.failures.length > 0) {
      lines.push('', '**Failures:**', '');
      for (const f of r.failures) lines.push(`- ${f}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
