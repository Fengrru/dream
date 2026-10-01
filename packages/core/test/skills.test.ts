import { describe, expect, it } from 'vitest';
import {
  bindSkillArgs,
  mineSkillBindings,
  type TaskTrace,
  type TraceStep,
} from '@dream/core';

function trace(percept: string, dataset: string): TaskTrace {
  const steps: TraceStep[] = [{ tool: 'analyze', args: { dataset } }];
  return { id: percept, taskType: 'analyze-data', steps, outcome: 'success', ts: 0, percept };
}

const STEPS: TraceStep[] = [{ tool: 'analyze', args: { dataset: 'sales.csv' } }];

describe('mineSkillBindings', () => {
  it('mines a slot with before/after anchors from repeated traces', () => {
    const bindings = mineSkillBindings(
      [trace('analyze sales.csv then summarize', 'sales.csv'), trace('analyze sales.csv again', 'sales.csv')],
      STEPS,
    );
    expect(bindings.length).toBe(1);
    expect(bindings[0]!.mode).toBe('slot');
    expect(bindings[0]!.before).toBe('analyze');
    expect(bindings[0]!.after).toBe('then'); // majority anchor from trace 1
    expect(bindings[0]!.example).toBe('sales.csv');
  });

  it('falls back to a checked literal when the value never appears in percepts', () => {
    const bindings = mineSkillBindings(
      [{ ...trace('run the numbers', 'sales.csv') }],
      STEPS,
    );
    expect(bindings[0]!.mode).toBe('literal');
  });

  it('leaves non-string arguments untouched', () => {
    const steps: TraceStep[] = [{ tool: 'analyze', args: { dataset: 'sales.csv', limit: 10 } }];
    const bindings = mineSkillBindings([trace('analyze sales.csv', 'sales.csv')], steps);
    expect(bindings.map((b) => b.key)).toEqual(['dataset']);
  });
});

describe('bindSkillArgs', () => {
  const meta = {
    strategy: { steps: STEPS },
    binding: mineSkillBindings(
      [trace('analyze sales.csv then summarize', 'sales.csv')],
      STEPS,
    ),
  };

  it('refills the slot from a new request (the E4 drift case)', () => {
    const result = bindSkillArgs(meta, 'analyze q4-budget.csv then summarize');
    expect(result.ok).toBe(true);
    expect((result.steps[0]!.args as { dataset: string }).dataset).toBe('q4-budget.csv');
  });

  it('fails closed when the anchor is missing — no silent stale-arg replay', () => {
    const result = bindSkillArgs(meta, 'run the usual analysis');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('anchor');
  });

  it('keeps the frozen value when the request repeats it', () => {
    const result = bindSkillArgs(meta, 'analyze sales.csv then summarize');
    expect(result.ok).toBe(true);
    expect((result.steps[0]!.args as { dataset: string }).dataset).toBe('sales.csv');
  });

  it('checked literals fail when the frozen value is absent from the request', () => {
    const literalMeta = {
      strategy: { steps: STEPS },
      binding: [{ stepIndex: 0, key: 'dataset', mode: 'literal' as const, example: 'sales.csv' }],
    };
    const ok = bindSkillArgs(literalMeta, 'analyze sales.csv again');
    expect(ok.ok).toBe(true);
    const rejected = bindSkillArgs(literalMeta, 'analyze anything else');
    expect(rejected.ok).toBe(false);
    expect(rejected.reason).toContain('sales.csv');
  });
});
