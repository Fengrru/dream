import { describe, expect, it } from 'vitest';
import { runAllSuites } from '../src/runner';

describe('Dream eval suites (offline, deterministic)', () => {
  it('all suites pass their thresholds', async () => {
    const results = await runAllSuites();
    const failures = results.flatMap((r) => r.failures.map((f) => `${r.name}: ${f}`));
    expect(failures, failures.join('\n')).toEqual([]);
    for (const r of results) {
      expect(r.passed, `${r.name} failed`).toBe(true);
    }
  }, 30_000);
});
