import type { ExperimentResult } from './harness';
import { e1Scaling } from './e1-scaling';
import { e2Consolidation } from './e2-consolidation';
import { e3Forgetting } from './e3-forgetting';
import { e4Skills } from './e4-skills';
import { e5Reconsolidation } from './e5-reconsolidation';
import { e6Budget } from './e6-budget';

export async function runAllExperiments(): Promise<ExperimentResult[]> {
  return [
    await e1Scaling(),
    await e2Consolidation(),
    await e3Forgetting(),
    await e4Skills(),
    await e5Reconsolidation(),
    await e6Budget(),
  ];
}

const VERDICT_MARK: Record<ExperimentResult['verdict'], string> = {
  works: 'WORKS — keep and build on this',
  partial: 'PARTIAL — useful but needs tuning or a missing piece',
  fails: 'FAILS — real weakness, fix before relying on it',
};

export function renderExperimentReport(results: ExperimentResult[]): string {
  const lines: string[] = [
    '# Dream — experiment report',
    '',
    `_Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} · deterministic unless marked live · runner: \`pnpm experiments\`_`,
    '',
    '## Overview',
    '',
    '| # | experiment | question | verdict |',
    '| --- | --- | --- | --- |',
  ];
  for (const r of results) {
    lines.push(`| ${r.id} | ${r.title} | ${r.question} | **${r.verdict.toUpperCase()}** |`);
  }
  lines.push('', '## Headline findings', '');
  for (const r of results) {
    for (const f of r.findings) lines.push(`- **${r.id}** — ${f}`);
  }
  lines.push('', '## Recommendations (ranked)', '');
  let i = 1;
  for (const r of results) {
    for (const rec of r.recommendations) {
      lines.push(`${i}. [${r.id}] ${rec}`);
      i++;
    }
  }
  for (const r of results) {
    lines.push(
      '',
      `---`,
      '',
      `## ${r.id} — ${r.title}`,
      '',
      `**Verdict:** ${VERDICT_MARK[r.verdict]}`,
      '',
      `**Question:** ${r.question}`,
      '',
      `**Hypothesis:** ${r.hypothesis}`,
      '',
      '**Method:**',
      '',
      ...r.method.map((m) => `- ${m}`),
      '',
    );
    for (const t of r.tables) {
      lines.push(`**${t.title}**`, '', `| ${t.columns.join(' | ')} |`, `| ${t.columns.map(() => '---').join(' | ')} |`);
      for (const row of t.rows) {
        lines.push(`| ${row.join(' | ')} |`);
      }
      lines.push('');
    }
    lines.push('**Findings:**', '');
    for (const f of r.findings) lines.push(`- ${f}`);
    lines.push('');
  }
  return lines.join('\n');
}
