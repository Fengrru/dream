/**
 * Deterministic entity/tag extraction.
 *
 * Tags are a retrieval channel, not a second index: they let an explicit
 * entity ("ZQ-4821", "Ada", 「星云7号」) nominate a memory even when the rest
 * of the sentence is phrased differently. No LLM, no NER model.
 */

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'my', 'i', 'we', 'you', 'he', 'she',
  'it', 'they', 'this', 'that', 'these', 'those', 'when', 'where', 'what',
  'who', 'why', 'how', 'is', 'are', 'was', 'were', 'do', 'does', 'did',
  'please', 'note', 'user', 'memory', 'project', 'service', 'task', 'plan',
  'meeting', 'update', 'flight', 'deploy', 'status', 'team', 'session',
]);

/** Explicit tags supplied by a caller plus deterministic surface entities. */
export function extractEntityTags(text: string): string[] {
  const tags = new Set<string>();

  // Capitalised names and identifiers (Ada, PostgreSQL, QF27, ZQ-4821).
  for (const match of text.matchAll(/\b[A-Z][A-Za-z0-9._-]{1,}\b/g)) {
    const value = match[0];
    if (value.length < 2) continue;
    if (STOPWORDS.has(value.toLowerCase())) continue;
    tags.add(value);
  }

  // Quoted names/titles, including CJK quotes.
  for (const match of text.matchAll(/[「“"']([^」”"']{2,40})[」”"']/g)) {
    const value = match[1]?.trim();
    if (value) tags.add(value);
  }

  // Lowercase identifiers with digits (qf27, svc01, v2).
  for (const match of text.matchAll(/\b[a-z]{2,}-?\d{1,}\b/g)) {
    tags.add(match[0]);
  }

  return [...tags].slice(0, 12);
}

/** Case-insensitive tag/query overlap; returns the matched tags. */
export function matchingTags(tags: readonly string[], query: string): string[] {
  const lowered = query.toLowerCase();
  return tags.filter((tag) => tag.length >= 2 && lowered.includes(tag.toLowerCase()));
}
