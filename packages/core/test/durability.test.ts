import { describe, expect, it } from 'vitest';
import { buildCore } from './helpers';

describe('Idempotent encoding', () => {
  it('returns the existing node when the same key is replayed', async () => {
    const { gate, store } = buildCore();
    const first = (await gate.encode({
      content: 'The deploy window is Friday at 2am',
      kind: 'percept',
      source: 'user',
      explicitFact: true,
      idempotencyKey: 'turn-42',
    }))!;
    const replay = (await gate.encode({
      content: 'The deploy window is Friday at 2am',
      kind: 'percept',
      source: 'user',
      explicitFact: true,
      idempotencyKey: 'turn-42',
    }))!;

    expect(replay.id).toBe(first.id);
    expect((await store.listNodes()).length).toBe(1);
    expect((await store.getNode(first.id))!.evidenceCount).toBe(1);

    const other = (await gate.encode({
      content: 'The deploy window is Friday at 2am',
      kind: 'percept',
      source: 'user',
      explicitFact: true,
      idempotencyKey: 'turn-43',
    }))!;
    expect(other.id).not.toBe(first.id);
  });
});
