/**
 * Rule-based relation cues.
 *
 * Typed edges are only useful if they are cheap and predictable. These cues
 * mark causal and contrast language at encode time; no LLM is involved, and a
 * missed cue degrades to the ordinary similar edge rather than a wrong fact.
 */

export interface RelationCues {
  causal: boolean;
  contrast: boolean;
}

const CAUSAL_PATTERNS = [
  /\bbecause\b/i,
  /\bdue to\b/i,
  /\bcaus(?:e|ed|es|ing)\b/i,
  /\bleads? to\b/i,
  /\bresult(?:ed|s|ing)? in\b/i,
  /因为/,
  /所以/,
  /导致/,
  /由于/,
  /因此/,
];

const CONTRAST_PATTERNS = [
  /\bbut\b/i,
  /\bhowever\b/i,
  /\binstead\b/i,
  /\brather than\b/i,
  /\balthough\b/i,
  /\bunlike\b/i,
  /但是/,
  /然而/,
  /相反/,
  /而是/,
  /虽然/,
  /不过/,
];

export function relationCues(text: string): RelationCues {
  return {
    causal: CAUSAL_PATTERNS.some((pattern) => pattern.test(text)),
    contrast: CONTRAST_PATTERNS.some((pattern) => pattern.test(text)),
  };
}
