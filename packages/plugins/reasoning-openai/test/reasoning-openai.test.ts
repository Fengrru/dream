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

  it('receives automatically recalled memories in the live reasoning path', async () => {
    let sawMemory = false;
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const system = body.messages[0].content as string;
      sawMemory = system.includes('QF27') && !system.includes('nothing recalled');
      return Response.json({ choices: [{ message: { content: 'Your flight is QF27.' } }] });
    }) as unknown as typeof fetch;

    const { kernel } = await buildWithFetch(fetchImpl);
    await kernel.encodeChunk({
      content: 'My flight is QF27',
      kind: 'percept',
      source: 'user',
      explicitFact: true,
    });
    const session = kernel.session();
    const turn = await session.submit('Which flight am I on?');
    expect(sawMemory).toBe(true);
    expect(turn.recalled.some((n) => n.content.includes('QF27'))).toBe(true);
    expect(turn.final).toBe('Your flight is QF27.');
  });

  it('applies a live correction through the memory_correct action', async () => {
    let corrected = false;
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const system = body.messages[0].content as string;
      if (!corrected) {
        corrected = true;
        expect(system).toContain('mem_wrong');
        return Response.json({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    id: '1',
                    type: 'function',
                    function: {
                      name: 'memory_correct',
                      arguments: JSON.stringify({ nodeId: 'mem_wrong', content: 'My flight is QF28' }),
                    },
                  },
                ],
              },
            },
          ],
        });
      }
      return Response.json({ choices: [{ message: { content: 'Memory updated.' } }] });
    }) as unknown as typeof fetch;

    const { kernel, store } = await buildWithFetch(fetchImpl);
    // Encode through the gate (real embedding), then rename to a stable id.
    const wrong = await kernel.encodeChunk({
      content: 'My flight is QF27',
      kind: 'percept',
      source: 'user',
      explicitFact: true,
    });
    await store.deleteNode(wrong!.id);
    await store.putNode({ ...wrong!, id: 'mem_wrong' });
    const session = kernel.session();
    const turn = await session.submit('Actually my flight is QF28');
    expect(turn.final).toContain('Memory updated');
    const after = await store.getNode('mem_wrong');
    expect(after!.content).toContain('QF28');
    expect(after!.version).toBe(2);
  });

  it('sends bounded conversation history to the model', async () => {
    let calls = 0;
    let sawHistory = false;
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      calls++;
      const body = JSON.parse(String(init?.body));
      if (calls === 2) {
        const messages = body.messages as Array<{ role: string; content?: string }>;
        sawHistory =
          messages.some((m) => m.role === 'user' && m.content === 'first question') &&
          messages.some((m) => m.role === 'assistant' && m.content === 'first answer');
      }
      return Response.json({
        choices: [{ message: { content: calls === 1 ? 'first answer' : 'second answer' } }],
      });
    }) as unknown as typeof fetch;

    const { kernel } = await buildWithFetch(fetchImpl);
    const session = kernel.session();
    await session.submit('first question');
    const second = await session.submit('second question');
    expect(sawHistory).toBe(true);
    expect(second.final).toBe('second answer');
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
