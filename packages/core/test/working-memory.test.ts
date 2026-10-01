import { describe, expect, it } from 'vitest';
import { WorkingMemory } from '../src/working-memory';
import { FakeClock } from './helpers';
import type { ChunkCandidate } from '../src/types';

function percept(content: string, source: ChunkCandidate['source'] = 'user'): ChunkCandidate {
  return { content, kind: 'percept', source };
}

describe('WorkingMemory', () => {
  it('holds up to capacity chunks', () => {
    const wm = new WorkingMemory(4);
    for (let i = 0; i < 4; i++) {
      expect(wm.attend(percept(`item ${i}`))).toBeNull();
    }
    expect(wm.readAll().length).toBe(4);
  });

  it('evicts the least-active chunk when over capacity and returns it', () => {
    const clock = new FakeClock();
    const wm = new WorkingMemory(4, clock.now);
    for (let i = 0; i < 4; i++) wm.attend(percept(`item ${i}`), 0.9);
    // item 0 refreshed less recently -> activation decays more on tick
    clock.advance(60_000);
    wm.tick();
    const evicted = wm.attend(percept('item 4'), 1);
    expect(evicted).not.toBeNull();
    expect(evicted!.candidate.content).toBe('item 0');
    expect(wm.readAll().some((c) => c.candidate.content === 'item 4')).toBe(true);
  });

  it('refresh keeps an attended chunk alive', () => {
    const clock = new FakeClock();
    const wm = new WorkingMemory(2, clock.now);
    wm.attend(percept('a'), 0.5);
    wm.attend(percept('b'), 0.9);
    clock.advance(61_000);
    const idA = wm.readAll().find((c) => c.candidate.content === 'a')!.id;
    wm.refresh(idA); // attentional refreshing: 'a' was just re-attended
    wm.tick();
    const evicted = wm.attend(percept('c'), 0.8);
    // Without the refresh, 'a' (0.5) would be the least-active chunk.
    expect(evicted).not.toBeNull();
    expect(evicted!.candidate.content).toBe('b');
  });

  it('drain returns everything and empties the bus', () => {
    const wm = new WorkingMemory(4);
    wm.attend(percept('a'));
    wm.attend(percept('b'));
    const drained = wm.drain();
    expect(drained.length).toBe(2);
    expect(wm.readAll().length).toBe(0);
  });
});
