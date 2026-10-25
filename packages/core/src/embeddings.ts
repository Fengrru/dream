/**
 * Embedding providers. Dream works with any embedding function; the kernel
 * ships a deterministic local provider (feature hashing) so the full memory
 * lifecycle runs offline and in tests, plus an OpenAI-compatible provider.
 */

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

/** Unicode-aware tokens; internal dots/hyphens keep filenames intact. */
const TOKEN_RE = /[\p{L}\p{N}]+(?:['’._-][\p{L}\p{N}]+)*/gu;

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(TOKEN_RE) ?? []).slice(0, 256);
}

function isCjk(ch: string): boolean {
  return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/.test(ch);
}

/** CJK has no spaces: character unigrams + bigrams give useful overlap. */
function cjkFeatures(token: string): string[] {
  const chars = [...token].filter(isCjk);
  if (chars.length === 0) return [];
  const out: string[] = [];
  for (let i = 0; i < chars.length; i++) {
    out.push(`cjk1:${chars[i]}`);
    if (i + 1 < chars.length) out.push(`cjk2:${chars[i]}${chars[i + 1]}`);
  }
  return out;
}

function normalize(vec: number[]): number[] {
  let sum = 0;
  for (const v of vec) sum += v * v;
  const norm = Math.sqrt(sum);
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}

/**
 * Crude deterministic English stemmer. Experiment E2 showed the unstemmed
 * bag-of-features space scoring query-vs-abstraction similarity just below
 * usable thresholds ("reviews" vs "review", "trips" vs "trip"). A suffix
 * stripper closes that gap without any dependency.
 */
function stem(token: string): string {
  // Suffix stripping is English-only; other scripts keep their surface form.
  if (!/^[a-z][a-z'._-]*$/.test(token)) return token;
  if (token.length <= 4) return token;
  if (token.endsWith('ies')) return token.slice(0, -3) + 'y';
  if (token.endsWith('es') && token.length > 5) return token.slice(0, -2);
  if (token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  if (token.endsWith('ing') && token.length > 6) return token.slice(0, -3);
  if (token.endsWith('ed') && token.length > 5) return token.slice(0, -2);
  return token;
}

export interface HashingEmbeddingOptions {
  /** Include token-bigram features (default true). Disable to ablate. */
  bigrams?: boolean;
}

/**
 * Deterministic feature-hashing embedding over word tokens and token bigrams.
 * Not semantically deep, but stable, dependency-free and good enough for
 * spreading activation, novelty scoring and offline evals.
 */
export class HashingEmbeddingProvider implements EmbeddingProvider {
  readonly dim: number;
  private readonly bigrams: boolean;

  constructor(dim = 256, options: HashingEmbeddingOptions = {}) {
    this.dim = dim;
    this.bigrams = options.bigrams ?? true;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.embedOne(t));
  }

  private embedOne(text: string): number[] {
    const vec = new Array<number>(this.dim).fill(0);
    const add = (feature: string, weight: number): void => {
      const idx = fnv1a32(feature) % this.dim;
      vec[idx] = (vec[idx] ?? 0) + weight;
    };
    const rawTokens = tokenize(text);
    const tokens = rawTokens.map(stem);
    for (const tok of tokens) add(tok, 1);
    for (const tok of rawTokens) {
      // CJK runs need sub-token features; the whole run is also kept above.
      for (const feature of cjkFeatures(tok)) add(feature, 0.75);
    }
    if (this.bigrams) {
      for (let i = 0; i + 1 < tokens.length; i++) {
        add(`${tokens[i]}_${tokens[i + 1]}`, 0.5);
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
  private readonly requestedDimensions?: number;

  constructor(config: OpenAIEmbeddingConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? 'text-embedding-3-small';
    this.baseUrl = (config.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.dim = config.dimensions ?? 1536;
    this.requestedDimensions = config.dimensions;
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
          body: JSON.stringify({
            model: this.model,
            input: batch,
            ...(this.requestedDimensions !== undefined
              ? { dimensions: this.requestedDimensions }
              : {}),
          }),
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) {
          const retriable = res.status === 429 || res.status >= 500;
          const err = new Error(`embedding request failed: HTTP ${res.status}`);
          if (!retriable) throw err;
          lastError = err;
        } else {
          const body = (await res.json()) as { data: Array<{ embedding: number[] }> };
          const vectors = body.data.map((d) => d.embedding);
          for (const vector of vectors) {
            if (vector.length !== this.dim) {
              throw new Error(
                `embedding provider returned dimension ${vector.length}, expected ${this.dim}; ` +
                  'set DREAM_EMBED_DIMENSIONS or use a new memory database',
              );
            }
          }
          return vectors;
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
  // A dimension mismatch means the vectors came from different embedding
  // models. Never compare prefixes: that yields a plausible-but-wrong score.
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  const n = a.length;
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
