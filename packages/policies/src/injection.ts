/**
 * Heuristic detection of prompt-injection payloads attempting to poison
 * permanent memory. This is a first line of defense, not a solver: flagged
 * content is quarantined (encoded with quarantined=true, excluded from
 * recall) rather than trusted, and can only be released through approval.
 *
 * Markers are weighted: STRONG markers are near-unambiguous attack phrasings
 * (2 points each); WEAK markers also occur in ordinary conversation ("you are
 * now connected", a developer pasting their own system prompt) and score 1.
 * With the default threshold of 2, a single strong marker quarantines, a
 * lone weak marker does not, and two weak markers do.
 */
const STRONG_MARKERS: string[] = [
  'ignore previous instructions',
  'ignore all previous',
  'disregard previous',
  'disregard all previous',
  'reveal your instructions',
  'reveal your system',
  'jailbreak',
  '<|im_start|>',
  '<|endoftext|>',
  '### system ###',
  'developer message',
];

const WEAK_MARKERS: string[] = [
  'disregard all',
  'system prompt',
  'you are now',
];

export interface InjectionScan {
  /** Weighted score: strong markers count 2, weak markers 1. */
  score: number;
  matched: string[];
}

export class InjectionHeuristics {
  scan(text: string): InjectionScan {
    const lower = text.toLowerCase();
    const matched: string[] = [];
    let score = 0;
    for (const m of STRONG_MARKERS) {
      if (lower.includes(m)) {
        matched.push(m);
        score += 2;
      }
    }
    for (const m of WEAK_MARKERS) {
      if (lower.includes(m)) {
        matched.push(m);
        score += 1;
      }
    }
    return { score, matched };
  }
}
