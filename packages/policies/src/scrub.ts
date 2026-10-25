export interface SecretFinding {
  kind: string;
  /** Preview of the matched region with the secret part elided. */
  preview: string;
}

interface SecretPattern {
  kind: string;
  regex: RegExp;
}

const PATTERNS: SecretPattern[] = [
  // Order matters: specific prefixes must run before the generic sk- / key
  // value patterns, or an Anthropic key gets mislabeled as an OpenAI key
  // (still redacted, but the finding kind is wrong).
  { kind: 'anthropic-key', regex: /sk-ant-[A-Za-z0-9_-]{16,}/g },
  { kind: 'github-token', regex: /gh[pousr]_[A-Za-z0-9]{30,}/g },
  { kind: 'aws-access-key', regex: /AKIA[0-9A-Z]{16}/g },
  { kind: 'google-api-key', regex: /AIza[0-9A-Za-z_-]{30,}/g },
  { kind: 'slack-token', regex: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  { kind: 'openai-key', regex: /sk-[A-Za-z0-9_-]{16,}/g },
  {
    kind: 'private-key',
    regex: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )*PRIVATE KEY-----/g,
  },
  { kind: 'jwt', regex: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g },
  { kind: 'bearer', regex: /[Bb]earer\s+[A-Za-z0-9._-]{16,}/g },
  { kind: 'key-value', regex: /(api[_-]?key|secret|token|password)["']?\s*[:=]\s*["']?[^\s"']{8,}/gi },
];

/**
 * Redacts credential-shaped strings from memory payloads. Runs on the
 * pre-write pipeline (before anything is encoded) and on the post-read
 * pipeline (before a model sees recalled content), as defense in depth.
 */
export class SecretScrubber {
  scrub(text: string): { redacted: string; findings: SecretFinding[] } {
    const findings: SecretFinding[] = [];
    let redacted = text;
    for (const { kind, regex } of PATTERNS) {
      redacted = redacted.replace(regex, (match) => {
        findings.push({ kind, preview: `${match.slice(0, 6)}…[REDACTED]` });
        return '[REDACTED]';
      });
    }
    return { redacted, findings };
  }
}
