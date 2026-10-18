import { describe, expect, it } from 'vitest';
import { extractRevisions, lineDiff } from '../src/revisions';

describe('Revision extraction (zero LLM)', () => {
  it('captures deterministic replacements with a real line diff', () => {
    const [revision] = extractRevisions(
      'apply_patch',
      { path: 'src/search.ts', old: 'timeout: 30\nretries: 2', new: 'timeout: 5\nretries: 2' },
      { ts: 123, sessionId: 's1' },
    );
    expect(revision).toMatchObject({
      artifactKey: 'src/search.ts',
      tool: 'apply_patch',
      ts: 123,
      sessionId: 's1',
    });
    expect(revision!.diff).toContain('- timeout: 30');
    expect(revision!.diff).toContain('+ timeout: 5');
    expect(revision!.oldContent).toContain('timeout: 30');
    expect(revision!.newContent).toContain('timeout: 5');
  });

  it('captures unified patches and derives the artifact path', () => {
    const patch = '*** Begin Patch\n*** Update File: src/client.py\n@@\n-timeout = 30\n+timeout = 5\n*** End Patch';
    const [revision] = extractRevisions('apply_patch', { patch }, { ts: 7 });
    expect(revision!.artifactKey).toBe('src/client.py');
    expect(revision!.diff).toBe(patch);
  });

  it('ignores no-op edits and non-edit tool calls', () => {
    expect(extractRevisions('write', { path: 'a.txt', old: 'x', new: 'x' }, { ts: 1 })).toEqual([]);
    expect(extractRevisions('weather', { city: 'Tokyo' }, { ts: 1 })).toEqual([]);
  });

  it('falls back to whole-block replacement for huge inputs', () => {
    const oldContent = Array.from({ length: 500 }, (_, i) => `old ${i}`).join('\n');
    const newContent = Array.from({ length: 500 }, (_, i) => `new ${i}`).join('\n');
    const diff = lineDiff(oldContent, newContent);
    expect(diff.startsWith('- ')).toBe(true);
    expect(diff).toContain('+ ');
  });
});
