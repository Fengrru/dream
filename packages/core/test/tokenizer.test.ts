import { describe, expect, it } from 'vitest';
import { HashingEmbeddingProvider, cosineSimilarity } from '../src/embeddings';
import { cjkTokens, embeddingTokens, lexicalTokens } from '../src/tokenizer';

describe('CJK tokenization', () => {
  it('embeds Chinese text as a non-zero vector and keeps related text close', async () => {
    const provider = new HashingEmbeddingProvider(256);
    const [fact, question, unrelated] = await provider.embed([
      '我的妹妹林小雨住在杭州。',
      '林小雨住在哪里？',
      '项目「星云7号」使用 PostgreSQL 存储。',
    ]);
    expect(Math.hypot(...fact!)).toBeGreaterThan(0);
    expect(Math.hypot(...question!)).toBeGreaterThan(0);
    expect(cosineSimilarity(fact!, question!)).toBeGreaterThan(
      cosineSimilarity(fact!, unrelated!),
    );
    expect(cosineSimilarity(fact!, question!)).toBeGreaterThan(0.35);
  });

  it('legacy cjk:false reproduces the zero-vector bug', async () => {
    const legacy = new HashingEmbeddingProvider(256, { cjk: false });
    const [vec] = await legacy.embed(['我喜欢科幻电影']);
    expect(Math.hypot(...vec!)).toBe(0);
  });

  it('produces word and character-bigram tokens for BM25', () => {
    const tokens = lexicalTokens('我喜欢科幻电影');
    expect(tokens).toContain('zhw:科幻');
    expect(tokens).toContain('zhb:科幻');
    expect(tokens).toContain('zhb:幻电');
    expect(tokens).toContain('zhb:电影');
  });

  it('does not change English embedding tokens', () => {
    expect(embeddingTokens('My sisters name is Ada')).toEqual([
      'my',
      'sister',
      'name',
      'is',
      'ada',
    ]);
    expect(cjkTokens('pure english')).toEqual([]);
  });
});
