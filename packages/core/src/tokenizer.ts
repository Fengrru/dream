/**
 * Text tokenization shared by the hashing embedder and the BM25 channel.
 *
 * The original implementation only recognised ASCII word characters, which
 * made every CJK string a zero vector and an empty lexical document. Chinese
 * is segmented with the built-in Intl.Segmenter (zero dependencies), then
 * enriched with character bigrams so recall degrades gracefully when word
 * segmentation disagrees between a memory and its query.
 */

/** Crude deterministic English stemmer (see embeddings.ts history). */
export function stem(token: string): string {
  if (token.length <= 4) return token;
  if (token.endsWith('ies')) return token.slice(0, -3) + 'y';
  if (token.endsWith('es') && token.length > 5) return token.slice(0, -2);
  if (token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  if (token.endsWith('ing') && token.length > 6) return token.slice(0, -3);
  if (token.endsWith('ed') && token.length > 5) return token.slice(0, -2);
  return token;
}

const ENGLISH_EMBED_RE = /[a-z0-9']+/g;
const ENGLISH_LEXICAL_RE = /[a-z0-9'._-]+/g;

const CJK_RUN_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g;

interface SegmentLike {
  segment: string;
  isWordLike?: boolean;
}

let wordSegmenter: { segment(input: string): Iterable<SegmentLike> } | null | undefined;

function getWordSegmenter(): { segment(input: string): Iterable<SegmentLike> } | null {
  if (wordSegmenter === undefined) {
    wordSegmenter =
      typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
        ? new Intl.Segmenter('zh', { granularity: 'word' })
        : null;
  }
  return wordSegmenter;
}

/** English tokens for the hashing embedder: lowercased, stemmed, apostrophes kept. */
export function englishEmbeddingTokens(text: string): string[] {
  return (text.toLowerCase().match(ENGLISH_EMBED_RE) ?? []).slice(0, 256).map(stem);
}

/** English tokens for BM25: identifiers keep dots/hyphens (file names, versions). */
export function englishLexicalTokens(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().match(ENGLISH_LEXICAL_RE) ?? []) {
    const token = raw.replace(/^[._-]+|[._-]+$/g, '');
    if (token.length === 0) continue;
    // The embedder's stemmer skips four-letter words ("uses" vs "use"); BM25
    // needs them conflated.
    const stemmed = stem(token);
    out.push(stemmed.length <= 4 && token.length > 3 && token.endsWith('s') && !token.endsWith('ss')
      ? token.slice(0, -1)
      : stemmed);
    if (out.length >= 512) break;
  }
  return out;
}

/**
 * CJK tokens: segmented words plus character bigrams. The two namespaces keep
 * word and bigram features distinct in the hashed space.
 */
export function cjkTokens(text: string): string[] {
  const runs = text.match(CJK_RUN_RE) ?? [];
  if (runs.length === 0) return [];
  const segmenter = getWordSegmenter();
  const out: string[] = [];
  for (const run of runs) {
    if (segmenter) {
      for (const part of segmenter.segment(run)) {
        if (!part.isWordLike) continue;
        const word = part.segment.trim();
        if (word.length > 0) out.push(`zhw:${word}`);
      }
    } else {
      // Dependency-free fallback: every character is a word.
      for (const char of run) out.push(`zhw:${char}`);
    }
    for (let i = 0; i + 1 < run.length; i++) {
      out.push(`zhb:${run.slice(i, i + 2)}`);
    }
  }
  return out;
}

export interface TokenizeOptions {
  /** Include CJK word/bigram features (default true). */
  cjk?: boolean;
}

/** Embedding tokens: English unigrams + CJK words/bigrams. */
export function embeddingTokens(text: string, options: TokenizeOptions = {}): string[] {
  const tokens = englishEmbeddingTokens(text);
  if (options.cjk !== false) tokens.push(...cjkTokens(text).slice(0, 256));
  return tokens;
}

/** BM25 tokens: identifier-friendly English + CJK words/bigrams. */
export function lexicalTokens(text: string, options: TokenizeOptions = {}): string[] {
  const tokens = englishLexicalTokens(text);
  if (options.cjk !== false) tokens.push(...cjkTokens(text).slice(0, 512));
  return tokens.slice(0, 512);
}
