import { describe, expect, it } from 'vitest';
import {
  HashingEmbeddingProvider,
  OpenAIEmbeddingProvider,
  cosineSimilarity,
} from '../src/embeddings';

describe('HashingEmbeddingProvider', () => {
  const provider = new HashingEmbeddingProvider(256);

  it('is deterministic', async () => {
    const [a, b] = await provider.embed(['same text', 'same text']);
    expect(cosineSimilarity(a!, b!)).toBeCloseTo(1);
  });

  it('separates unrelated texts', async () => {
    const [a, b] = await provider.embed(['quarterly revenue report', 'weather forecast sunny']);
    expect(cosineSimilarity(a!, b!)).toBeLessThan(0.3);
  });

  it('keeps related texts close', async () => {
    const [a, b] = await provider.embed([
      'my sisters name is ada',
      'what is my sisters name',
    ]);
    expect(cosineSimilarity(a!, b!)).toBeGreaterThan(0.6);
  });
});

describe('OpenAIEmbeddingProvider', () => {
  it('calls the /embeddings endpoint and retries transient failures', async () => {
    let calls = 0;
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      calls++;
      if (calls === 1) {
        return new Response('rate limited', { status: 429 });
      }
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe('text-embedding-3-small');
      return Response.json({ data: body.input.map(() => ({ embedding: [1, 0.5] })) });
    }) as unknown as typeof fetch;

    const provider = new OpenAIEmbeddingProvider({
      apiKey: 'test', fetchImpl, baseUrl: 'https://example.com/v1', dimensions: 2,
    });
    const out = await provider.embed(['a', 'b']);
    expect(calls).toBe(2); // 1 rate-limited attempt + 1 successful retry of the batch
    expect(out.length).toBe(2);
    expect(out[0]![0]).toBe(1);
  });
});
