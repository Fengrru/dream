/**
 * Deterministic revision extraction (zero LLM).
 *
 * Tool calls are the ground truth of what changed. A summary memory keeps the
 * decision ("the search timeout fix"); the revision chain keeps the exact
 * before/after text and diff, so a later "which version was finally kept?"
 * question can be answered from the real edit rather than from a paraphrase.
 */

import type { RevisionInput } from './types';

const PATH_KEYS = ['path', 'file', 'filename', 'filePath', 'file_path'] as const;
const OLD_KEYS = ['old', 'oldText', 'old_string', 'oldStr', 'before'] as const;
const NEW_KEYS = ['new', 'newText', 'new_string', 'newStr', 'after', 'content'] as const;
const PATCH_KEYS = ['patch', 'diff', 'unifiedDiff'] as const;

function asRecord(args: unknown): Record<string, unknown> | null {
  return args !== null && typeof args === 'object' ? (args as Record<string, unknown>) : null;
}

function firstString(obj: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

function artifactPathFromPatch(patch: string): string | undefined {
  const markers = [
    /^\*\*\* Update File: (.+)$/m,
    /^\+\+\+ (?:b\/)?(.+)$/m,
    /^--- (?:a\/)?(.+)$/m,
  ];
  for (const marker of markers) {
    const match = patch.match(marker);
    if (match?.[1]) return match[1].trim();
  }
  return undefined;
}

/** Minimal line diff: LCS when small, whole-block replacement when huge. */
export function lineDiff(oldContent: string | undefined, newContent: string): string {
  if (oldContent === undefined) {
    return newContent
      .split('\n')
      .map((line) => `+ ${line}`)
      .join('\n');
  }
  if (oldContent === newContent) return '';
  const a = oldContent.split('\n').slice(0, 200);
  const b = newContent.split('\n').slice(0, 200);
  if (a.length * b.length > 40_000) {
    return `- ${oldContent.slice(0, 2000)}\n+ ${newContent.slice(0, 2000)}`;
  }

  const dp: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push(`  ${a[i]}`);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push(`- ${a[i]}`);
      i++;
    } else {
      out.push(`+ ${b[j]}`);
      j++;
    }
  }
  while (i < a.length) out.push(`- ${a[i++]}`);
  while (j < b.length) out.push(`+ ${b[j++]}`);
  return out.join('\n');
}

/**
 * Extract revisions from a successful tool call. Recognises:
 * - deterministic replacements: { path, old, new }
 * - file writes: { path, content } (old optional)
 * - unified patches: { patch } / apply_patch-style tool results
 */
export function extractRevisions(
  tool: string,
  args: unknown,
  context: { sessionId?: string; ts: number },
): RevisionInput[] {
  const obj = asRecord(args);
  if (!obj) return [];

  const patch = firstString(obj, PATCH_KEYS);
  if (patch && patch.trim().length > 0) {
    return [
      {
        artifactKey: artifactPathFromPatch(patch) ?? 'patch',
        tool,
        sessionId: context.sessionId,
        ts: context.ts,
        diff: patch,
      },
    ];
  }

  const artifactKey = firstString(obj, PATH_KEYS);
  if (!artifactKey) return [];
  const oldContent = firstString(obj, OLD_KEYS);
  const newContent = firstString(obj, NEW_KEYS);
  if (newContent === undefined) return [];
  if (oldContent !== undefined && oldContent === newContent) return [];

  return [
    {
      artifactKey,
      tool,
      sessionId: context.sessionId,
      ts: context.ts,
      oldContent,
      newContent,
      diff: lineDiff(oldContent, newContent),
    },
  ];
}
