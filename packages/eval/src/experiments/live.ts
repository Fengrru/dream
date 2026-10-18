import type { EmbeddingProvider } from '@dream/core';

/**
 * Optional live embedding provider. The suite stays offline by default; when
 * OPENAI_API_KEY or DREAM_EMBEDDING_API_KEY exists, E8/E12/E15 can re-run their
 * conclusions against a real embedding space.
 */
export async function liveEmbeddingProvider(): Promise<{
  provider: EmbeddingProvider;
  label: string;
} | null> {
  const apiKey = process.env.DREAM_EMBEDDING_API_KEY ?? process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const { OpenAIEmbeddingProvider } = await import('@dream/core');
  const model = process.env.DREAM_EMBEDDING_MODEL ?? 'text-embedding-3-small';
  return {
    provider: new OpenAIEmbeddingProvider({
      apiKey,
      model,
      baseUrl: process.env.DREAM_EMBEDDING_BASE_URL,
    }),
    label: model,
  };
}

export const LIVE_SKIP_NOTE =
  'skipped — no DREAM_EMBEDDING_API_KEY / OPENAI_API_KEY (offline hash embedder conclusions remain)';
