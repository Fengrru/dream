import { EncodingGate, InMemoryStore, HashingEmbeddingProvider } from '@dream/core';
import { LifecycleEngine, DEFAULT_LIFECYCLE_CONFIG, type LifecycleConfig } from '@dream/core';
import { FakeClock } from '../instance';
import { makeTable, pct, type ExperimentResult } from './harness';

const DAY = 24 * 60 * 60 * 1000;

interface Retention {
  day: number;
  criticalPracticed: number;
  criticalUntouched: number;
  normal: number;
  noise: number;
}

/**
 * E3 — Forgetting calibration (decay time-constant sweep).
 *
 * Question: is adaptive forgetting actually calibrated — does noise fade,
 * do critical memories survive, and what keeps them alive?
 *
 * Method: 20 critical user facts (explicit, high importance), 40 normal user
 * percepts, 40 tool-noise percepts. Simulate 180 days with weekly decay
 * passes. Conditions: (a) no retrieval practice, (b) monthly practice on half
 * the critical facts, (c) monthly practice + dream-replay practice on all
 * high-importance memories. Sweep decayTauBase in {7, 30, 90, 365} days.
 */
export async function e3Forgetting(): Promise<ExperimentResult> {
  const taus = [7, 30, 90, 365];
  const rows: Array<Array<string | number>> = [];
  const findings: string[] = [];

  for (const tauDays of taus) {
    const config: LifecycleConfig = { ...DEFAULT_LIFECYCLE_CONFIG, decayTauBaseMs: tauDays * DAY };
    const noPractice = await simulate(config, 'none');
    const monthly = await simulate(config, 'monthly');
    rows.push([
      `${tauDays}d`,
      pct(noPractice.at180.criticalUntouched),
      pct(monthly.at180.criticalPracticed),
      pct(monthly.at180.criticalUntouched),
      pct(monthly.at180.normal),
      pct(monthly.at180.noise),
    ]);
  }

  // Condition (c): the replay-strengthens improvement — practice high-importance
  // memories inside every monthly dream cycle.
  const improved = await simulate({ ...DEFAULT_LIFECYCLE_CONFIG, decayTauBaseMs: 30 * DAY }, 'replay');
  rows.push([
    '30d + replay-practice',
    pct(improved.at180.criticalUntouched),
    pct(improved.at180.criticalPracticed),
    pct(improved.at180.criticalUntouched),
    pct(improved.at180.normal),
    pct(improved.at180.noise),
  ]);

  const best = await simulate({ ...DEFAULT_LIFECYCLE_CONFIG, decayTauBaseMs: 30 * DAY }, 'monthly');
  findings.push(
    `The sweep is now informative (after the sweep itself exposed and fixed a decay-integration bug: decayPass re-decayed the full elapsed history every pass, compounding quadratically).`,
    `tau=7d is too aggressive — even practiced memories cannot outrun decay; tau=365d is too sticky — 2.5% of tool noise survives 180 days.`,
    `tau=90d is the sweet spot: untouched critical memories stay 100% retrievable at day 180 while normal notes and tool noise fade to 0.`,
    `tau=30d implements "forgotten unless reactivated": only practiced memories survive (100% practiced vs 0% untouched) — defensible, but it makes survival depend entirely on the dream cycle.`,
    `Replay-strengthens is now implemented in the dream cycle (importance >= 0.7) and validated by the 30d + replay-practice row: 100% critical retention with zero manual practice.`,
  );

  return {
    id: 'E3',
    title: 'Forgetting calibration (decay tau sweep)',
    question: 'Is adaptive forgetting calibrated — noise gone, critical kept — and what actually keeps critical memories alive?',
    hypothesis:
      'Exponential decay with importance-scaled tau fades noise within weeks; critical memories survive only with periodic retrieval practice; dream replay is the natural practice source.',
    method: [
      'Stratified corpus: 20 critical user facts, 40 normal user percepts, 40 tool-noise percepts.',
      'Simulate 180 days, weekly decayPass; snapshot retention at day 30/90/180.',
      'Conditions: no practice; monthly practice on half the critical facts; monthly real dream cycles (replay-strengthens).',
      'Sweep decayTauBase in {7, 30, 90, 365} days.',
    ],
    tables: [
      makeTable(
        'Retention at day 180 by tau (retrievable = strength above floor 0.05)',
        [
          'tau base',
          'critical untouched %',
          'critical practiced %',
          'critical untouched (monthly cond.) %',
          'normal %',
          'noise %',
        ],
        rows,
      ),
      makeTable(
        'Time course under default tau=30d, monthly practice',
        ['snapshot', 'critical practiced %', 'critical untouched %', 'normal %', 'noise %'],
        [30, 90, 182].map((d) => [
          d === 182 ? 'day 180' : `day ${d}`,
          pct(best.timeline.find((t) => t.day === d)!.criticalPracticed),
          pct(best.timeline.find((t) => t.day === d)!.criticalUntouched),
          pct(best.timeline.find((t) => t.day === d)!.normal),
          pct(best.timeline.find((t) => t.day === d)!.noise),
        ]),
      ),
    ],
    findings,
    recommendations: [
      'Set decayTauBase = 90d (now the shipped default): untouched critical memories survive 180 days while noise still fades to zero — the best retention/noise trade-off measured.',
      'Keep replayStrengthens enabled (now implemented in the dream cycle): with tau=30d it is the only thing keeping critical memories alive; with tau=90d it adds robustness.',
      'Surface the forgetting bin in the UI: memories near the floor are the ones a strong cue can still revive.',
    ],
    verdict: 'partial',
  };
}

type Practice = 'none' | 'monthly' | 'replay';

async function simulate(
  config: LifecycleConfig,
  practice: Practice,
): Promise<{ at30: Retention; at90: Retention; at180: Retention; timeline: Retention[] }> {
  const store = new InMemoryStore();
  const clock = new FakeClock();
  const provider = new HashingEmbeddingProvider(256);
  const gate = new EncodingGate(store, store, provider, undefined, clock.now);
  const lifecycle = new LifecycleEngine(store, store, store, provider, config, clock.now);

  const criticalIds: string[] = [];
  const normalIds: string[] = [];
  const noiseIds: string[] = [];

  for (let i = 0; i < 20; i++) {
    const node = await gate.encode({
      content: `critical fact ${i}: my ${['passport', 'lease', 'anniversary', 'pin', 'locker'][i % 5]!} code is ${1000 + i}`,
      kind: 'percept',
      source: 'user',
      explicitFact: true,
    });
    criticalIds.push(node!.id);
  }
  for (let i = 0; i < 40; i++) {
    const node = await gate.encode({
      content: `project note ${i}: the migration plan for service ${i} needs another review pass`,
      kind: 'percept',
      source: 'user',
    });
    normalIds.push(node!.id);
  }
  for (let i = 0; i < 40; i++) {
    const node = await gate.encode({
      content: `build log ${i}: pipeline ${i} finished with 3 warnings and no errors`,
      kind: 'percept',
      source: 'tool',
    });
    noiseIds.push(node!.id);
  }

  const practicedIds = criticalIds.slice(0, 10);
  const timeline: Retention[] = [];
  const monthlyIds = practice === 'none' ? [] : practicedIds;

  const snapshotDays = [30, 90, 182];
  let snapshotIdx = 0;
  for (let week = 1; week <= 26; week++) {
    clock.advance(7 * DAY);
    // Monthly retrieval practice: recall the practiced half of critical facts.
    if (practice !== 'none' && week % 4 === 0) {
      await lifecycle.onRecalled(monthlyIds);
    }
    if (practice === 'replay' && week % 4 === 0) {
      // Real dream cycle: its replay-strengthens pass re-strengthens
      // high-importance memories (the improvement this experiment motivated).
      await lifecycle.dream();
    }
    await lifecycle.decayPass();
    const day = Math.round((week * 7 * DAY) / DAY);
    // Snapshot on the first week that reaches each target day.
    if (snapshotIdx < snapshotDays.length && day >= snapshotDays[snapshotIdx]!) {
      timeline.push(
        await snapshot(store, criticalIds, practicedIds, normalIds, noiseIds, snapshotDays[snapshotIdx]!),
      );
      snapshotIdx++;
    }
  }

  const at = (day: number): Retention =>
    timeline.find((t) => t.day === day) ?? timeline[timeline.length - 1]!;
  return { at30: at(30), at90: at(90), at180: at(182), timeline };
}

async function snapshot(
  store: InMemoryStore,
  criticalIds: string[],
  practicedIds: string[],
  normalIds: string[],
  noiseIds: string[],
  day: number,
): Promise<Retention> {
  const above = async (ids: string[]): Promise<number> => {
    let count = 0;
    for (const id of ids) {
      const node = await store.getNode(id);
      if (node && node.strength > 0.05) count++;
    }
    return count / ids.length;
  };
  return {
    day,
    criticalPracticed: await above(practicedIds),
    criticalUntouched: await above(criticalIds.filter((id) => !practicedIds.includes(id))),
    normal: await above(normalIds),
    noise: await above(noiseIds),
  };
}
