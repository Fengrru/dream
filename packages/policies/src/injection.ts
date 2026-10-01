/**
 * Heuristic detection of prompt-injection payloads attempting to poison
 * permanent memory. This is a first line of defense, not a solver: flagged
 * content is quarantined (encoded with quarantined=true, excluded from
 * recall) rather than trusted, and can only be released through approval.
 */
const MARKERS: string[] = [
  'ignore previous instructions',
  'ignore all previous',
  'disregard previous',
  'disregard all',
  'system prompt',
  'you are now',
  'reveal your instructions',
  'reveal your system',
  'jailbreak',
  '<|im_start|>',
  '<|endoftext|>',
  '### system ###',
  'developer message',
];

export interface InjectionScan {
  score: number;
  matched: string[];
}

export class InjectionHeuristics {
  scan(text: string): InjectionScan {
    const lower = text.toLowerCase();
    const matched = MARKERS.filter((m) => lower.includes(m));
    return { score: matched.length, matched };
  }
}
