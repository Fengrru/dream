import type { SkillBinding, TaskTrace, TraceStep } from './types';

/**
 * Parameter slot mining and binding for procedural skills.
 *
 * Experiment E4 showed that replaying frozen tool arguments fails SILENTLY
 * under parameter drift (the worst failure class: the tool runs happily on
 * the wrong dataset). These two functions close that hole:
 *
 * - `mineSkillBindings` (at induction): locate each string argument inside
 *   the training percepts; if it appears between stable anchor tokens, the
 *   argument becomes a SLOT — a placeholder to be refilled at execution time.
 * - `bindSkillArgs` (at execution): refill the slots from the incoming
 *   request. Any slot or literal that cannot be resolved fails CLOSED — the
 *   executive skips the skill and falls back to explicit reasoning instead
 *   of executing with stale arguments.
 */

const TOKEN_RE = /[a-z0-9'._-]+/g;

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(TOKEN_RE) ?? []);
}

function findValueIndex(tokens: string[], valueTokens: string[]): number {
  if (valueTokens.length === 0) return -1;
  outer: for (let i = 0; i + valueTokens.length <= tokens.length; i++) {
    for (let j = 0; j < valueTokens.length; j++) {
      if (tokens[i + j] !== valueTokens[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function majorityValue(counts: Map<string, number>): string | undefined {
  let best: string | undefined;
  let n = 0;
  for (const [value, count] of counts) {
    if (count > n) {
      best = value;
      n = count;
    }
  }
  return best;
}

/** Dot-path access into nested argument objects ('dataset', 'query.limit'). */
function getPath(obj: unknown, path: string): unknown {
  let cursor: unknown = obj;
  for (const part of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[part]!;
  }
  return cursor;
}

function setPath(obj: unknown, path: string, value: unknown): void {
  const parts = path.split('.');
  let cursor: Record<string, unknown> = obj as Record<string, unknown>;
  for (let i = 0; i < parts.length - 1; i++) {
    let next = cursor[parts[i]!];
    if (next === null || typeof next !== 'object') {
      next = {};
      cursor[parts[i]!] = next;
    }
    cursor = next as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]!] = value;
}

/**
 * Mine parameter slots from successful traces. String arguments (at any
 * nested dot-path) participate: located inside the training percepts they
 * become slots; otherwise they become presence-checked literals.
 * Non-string arguments stay frozen (replayed as trained) — documented
 * residual risk for non-user-facing parameters.
 */
export function mineSkillBindings(traces: TaskTrace[], steps: TraceStep[]): SkillBinding[] {
  const usable = traces.filter(
    (t) => typeof t.percept === 'string' && t.percept.length > 0 && t.steps.length === steps.length,
  );
  const bindings: SkillBinding[] = [];

  steps.forEach((step, stepIndex) => {
    const args = (step.args ?? {}) as Record<string, unknown>;
    for (const [key, value] of flattenStrings(args)) {
      if (value.length === 0) continue;
      const valueTokens = tokenize(value);
      if (valueTokens.length === 0) continue;

      let seen = 0;
      const beforeCounts = new Map<string, number>();
      const afterCounts = new Map<string, number>();
      for (const trace of usable) {
        const traceStep = trace.steps[stepIndex];
        if (!traceStep) continue;
        const traceValue = getPath(traceStep.args, key);
        if (traceValue !== value) continue;
        const tokens = tokenize(trace.percept!);
        const idx = findValueIndex(tokens, valueTokens);
        if (idx < 0) continue;
        seen++;
        const before = idx > 0 ? tokens[idx - 1] : undefined;
        const afterIdx = idx + valueTokens.length;
        const after = afterIdx < tokens.length ? tokens[afterIdx] : undefined;
        if (before) beforeCounts.set(before, (beforeCounts.get(before) ?? 0) + 1);
        if (after) afterCounts.set(after, (afterCounts.get(after) ?? 0) + 1);
      }

      if (seen === 0) {
        bindings.push({ stepIndex, key, mode: 'literal', example: value });
        continue;
      }
      const before = majorityValue(beforeCounts);
      const after = majorityValue(afterCounts);
      if (!before && !after) {
        // The value floats free in the training percepts — no stable anchor,
        // so extraction is unreliable. Fall back to a presence-checked literal.
        bindings.push({ stepIndex, key, mode: 'literal', example: value });
        continue;
      }
      bindings.push({ stepIndex, key, mode: 'slot', before, after, example: value });
    }
  });

  return bindings;
}

/** All string values reachable in an args object, keyed by dot-path. */
function flattenStrings(obj: unknown, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  if (obj === null || typeof obj !== 'object') return out;
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out.set(path, value);
    else if (value !== null && typeof value === 'object') {
      for (const [p, v] of flattenStrings(value, path)) out.set(p, v);
    }
  }
  return out;
}

export interface SkillBindingResult {
  ok: boolean;
  steps: TraceStep[];
  reason?: string;
}

/**
 * Refill skill argument slots from the incoming request. Fails closed: any
 * unresolvable slot or absent literal aborts the implicit execution.
 */
export function bindSkillArgs(meta: unknown, percept: string): SkillBindingResult {
  const m = meta as
    | { strategy?: { steps?: TraceStep[] }; binding?: SkillBinding[] }
    | undefined;
  const frozen = m?.strategy?.steps;
  if (!frozen || frozen.length === 0) {
    return { ok: false, steps: [], reason: 'skill has no strategy' };
  }
  const bindings = m?.binding ?? [];
  const steps: TraceStep[] = frozen.map((s) => ({
    tool: s.tool,
    args: s.args === undefined ? undefined : (JSON.parse(JSON.stringify(s.args)) as unknown),
  }));
  if (bindings.length === 0) {
    return { ok: true, steps };
  }

  const tokens = tokenize(percept);
  for (const b of bindings) {
    const step = steps[b.stepIndex];
    if (!step) return { ok: false, steps: [], reason: `binding step ${b.stepIndex} out of range` };

    if (b.mode === 'literal') {
      const exampleTokens = tokenize(b.example);
      if (exampleTokens.length > 0 && findValueIndex(tokens, exampleTokens) < 0) {
        return {
          ok: false,
          steps: [],
          reason: `literal argument "${b.key}" ("${b.example}") does not appear in the request`,
        };
      }
      continue;
    }

    let value: string | undefined;
    // Anchors are location HINTS, not hard requirements: the request's wording
    // around the value usually drifts (e.g. the training's trailing "(run 1)"
    // becomes "again please"). Resolve with the before-anchor when present,
    // fall back to the after-anchor, and only fail closed when NEITHER anchor
    // appears — that means the request does not resemble the learned shape.
    // Residual v1 limitation: with the after-anchor absent, the value is
    // assumed to be the single token following the before-anchor.
    if (b.before) {
      const i = tokens.indexOf(b.before);
      if (i >= 0) {
        if (b.after) {
          const j = tokens.indexOf(b.after, i + 1);
          if (j > i + 1) value = tokens.slice(i + 1, j).join(' ');
        }
        if (value === undefined && i + 1 < tokens.length) value = tokens[i + 1]!;
      }
    }
    if (value === undefined && b.after) {
      const j = tokens.indexOf(b.after);
      if (j >= 1) value = tokens[j - 1]!;
    }
    if (value === undefined) {
      return {
        ok: false,
        steps: [],
        reason: 'request does not match the learned slot shape (anchors absent)',
      };
    }
    setPath(step.args, b.key, value);
  }
  return { ok: true, steps };
}
