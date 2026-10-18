/**
 * Embedding providers. Dream works with any embedding function; the kernel
 * ships a deterministic local provider (feature hashing) so the full memory
 * lifecycle runs offline and in tests, plus an OpenAI-compatible provider.
 */

import { cjkTokens, englishEmbeddingTokens, stem } from './tokenizer';

export { stem };

export interface EmbeddingProvider {
  readonly dim: number;
  embed(texts: string[]): Promise<number[][]>;
}

function fnv1a32(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function normalize(vec: number[]): number[] {
  let sum = 0;
  for (const v of vec) sum += v * v;
  const norm = Math.sqrt(sum);
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}

export interface HashingEmbeddingOptions {
  /** Include token-bigram features (default true). Disable to ablate. */
  bigrams?: boolean;
  /** Include CJK word/character-bigram features (default true). */
  cjk?: boolean;
}

/**
 * Deterministic feature-hashing embedding over word tokens and token bigrams.
 * Not semantically deep, but stable, dependency-free and good enough for
 * spreading activation, novelty scoring and offline evals.
 */
export class HashingEmbeddingProvider implements EmbeddingProvider {
  readonly dim: number;
  private readonly bigrams: boolean;
  private readonly cjk: boolean;

  constructor(dim = 256, options: HashingEmbeddingOptions = {}) {
    this.dim = dim;
    this.bigrams = options.bigrams ?? true;
    this.cjk = options.cjk ?? true;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.embedOne(t));
  }

  private embedOne(text: string): number[] {
    const vec = new Array<number>(this.dim).fill(0);
    const tokens = englishEmbeddingTokens(text);
    for (const tok of tokens) {
      const idx = fnv1a32(tok) % this.dim;
      vec[idx] = (vec[idx] ?? 0) + 1;
    }
    if (this.bigrams) {
      for (let i = 0; i + 1 < tokens.length; i++) {
        const bigram = `${tokens[i]}_${tokens[i + 1]}`;
        const idx = fnv1a32(bigram) % this.dim;
        vec[idx] = (vec[idx] ?? 0) + 0.5;
      }
    }
    if (this.cjk) {
      for (const tok of cjkTokens(text).slice(0, 256)) {
        const idx = fnv1a32(tok) % this.dim;
        vec[idx] = (vec[idx] ?? 0) + 1;
      }
    }
    return normalize(vec);
  }
}

export interface OpenAIEmbeddingConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  dimensions?: number;
  fetchImpl?: typeof fetch;
}

/** OpenAI-compatible /embeddings client with retry on transient failures. */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly dim: number;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: OpenAIEmbeddingConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? 'text-embedding-3-small';
    this.baseUrl = (config.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.dim = config.dimensions ?? 1536;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 100) {
      const batch = texts.slice(i, i + 100);
      out.push(...(await this.embedBatch(batch)));
    }
    return out;
  }

  private async embedBatch(batch: string[]): Promise<number[][]> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await this.fetchImpl(`${this.baseUrl}/embeddings`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({ model: this.model, input: batch }),
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) {
          const retriable = res.status === 429 || res.status >= 500;
          const err = new Error(`embedding request failed: HTTP ${res.status}`);
          if (!retriable) throw err;
          lastError = err;
        } else {
          const body = (await res.json()) as { data: Array<{ embedding: number[] }> };
          return body.data.map((d) => d.embedding);
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('embedding request failed')) {
          if (!(err.message.includes('HTTP 429') || /HTTP 5\d\d/.test(err.message))) throw err;
          lastError = err;
        } else {
          lastError = err;
        }
      }
      await sleep(300 * 2 ** attempt + Math.random() * 200);
    }
    throw new Error(`embedding request failed after 3 attempts: ${String(lastError)}`);
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
