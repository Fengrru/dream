import { describe, expect, it } from 'vitest';
import { HashingEmbeddingProvider, InMemoryStore } from '@dream/core';
import { DreamKernel } from '@dream/kernel';
import { MockToolsPlugin } from '@dream/plugin-scripted';
import { OpenAIReasoningPlugin } from '../src';
import { FakeClock } from '../../../core/test/helpers';

async function buildWithFetch(fetchImpl: typeof fetch) {
  const store = new InMemoryStore();
  const clock = new FakeClock();
  const kernel = new DreamKernel(
    {
      memory: store,
      journal: store,
      traces: store,
      provider: new HashingEmbeddingProvider(),
      clock: clock.now,
    },
    { preset: 'companion' },
  );
  const plugin = new OpenAIReasoningPlugin({
    apiKey: 'test-key',
    model: 'test-model',
    baseUrl: 'https://example.com/v1',
    fetchImpl,
  });
  await kernel.use(plugin);
  await kernel.use(new MockToolsPlugin());
  return { kernel, store, clock };
}

describe('OpenAIReasoningPlugin', () => {
  it('emits tool calls when the model requests them, then the final answer', async () => {
    let sawTools = false;
    let toolCallReturned = false;
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      sawTools = sawTools || (Array.isArray(body.tools) && body.tools.length > 0);
      const system = body.messages[0].content as string;
      expect(system).toContain('You are Dream');
      expect(system).toContain('self-model');
      if (!toolCallReturned) {
        toolCallReturned = true;
        return Response.json({
          choices: [
            {
              message: {
                tool_calls: [
                  { id: '1', type: 'function', function: { name: 'weather', arguments: '{"city":"Tokyo"}' } },
                ],
              },
            },
          ],
        });
      }
      return Response.json({ choices: [{ message: { content: 'Tokyo is sunny today.' } }] });
    }) as unknown as typeof fetch;

    const { kernel } = await buildWithFetch(fetchImpl);
    const session = kernel.session();
    const turn = await session.submit('weather in Tokyo?');
    expect(sawTools).toBe(true);
    expect(turn.toolResults.length).toBe(1);
    expect(String(turn.toolResults[0])).toContain('sunny');
    expect(turn.reasoningCalls).toBe(2);
    expect(turn.final).toBe('Tokyo is sunny today.');
  });

  it('emits a final answer with the recalled-memory block included', async () => {
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const system = body.messages[0].content as string;
      return Response.json({
        choices: [{ message: { content: `echo:${system.includes('nothing recalled') ? 'empty' : 'memory'}` } }],
      });
    }) as unknown as typeof fetch;

    const { kernel } = await buildWithFetch(fetchImpl);
    const session = kernel.session();
    const turn = await session.submit('hello there');
    expect(turn.final).toBe('echo:empty');
    expect(turn.reasoningCalls).toBe(1);
  });

  it('retries transient server errors and surfaces a clear failure', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response('boom', { status: 500 });
    }) as unknown as typeof fetch;

    const { kernel } = await buildWithFetch(fetchImpl);
    const session = kernel.session();
    const turn = await session.submit('anything');
    expect(calls).toBe(3);
    expect(turn.final).toContain('Reasoning failed');
  });
});
