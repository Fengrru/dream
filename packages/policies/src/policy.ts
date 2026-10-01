import type { MemoryOp, PolicyDecision } from '@dream/core';

export type PolicyPreset = 'companion' | 'amnesiac' | 'headless';

/**
 * Human approval for sensitive memory operations. When no service is mounted
 * (unattended/headless operation), every "ask" resolves to DENY — an
 * unattended agent must not be able to approve itself. Fail-closed by design.
 */
export interface ApprovalService {
  request(op: MemoryOp): Promise<'allow' | 'deny'>;
}

interface PresetRules {
  encode: PolicyDecision;
  recall: PolicyDecision;
  update: PolicyDecision;
  forget: PolicyDecision;
  purge: PolicyDecision;
  'self-read': PolicyDecision;
  'tool-execute': PolicyDecision;
}

/**
 * Permission presets, named honestly (the unsafe one is called what it is):
 * - companion (default): full memory lifecycle; destructive ops need approval.
 * - amnesiac: read-only — the agent may recall but never encode ("chat without memory").
 * - headless: unattended. Every ask resolves to deny, structurally.
 */
const PRESETS: Record<PolicyPreset, PresetRules> = {
  companion: {
    encode: 'allow',
    recall: 'allow',
    update: 'allow',
    forget: 'ask',
    purge: 'ask',
    'self-read': 'allow',
    'tool-execute': 'allow',
  },
  amnesiac: {
    encode: 'deny',
    recall: 'allow',
    update: 'deny',
    forget: 'deny',
    purge: 'deny',
    'self-read': 'allow',
    'tool-execute': 'allow',
  },
  headless: {
    encode: 'allow',
    recall: 'allow',
    update: 'allow',
    forget: 'deny',
    purge: 'deny',
    'self-read': 'allow',
    'tool-execute': 'allow',
  },
};

export class MemoryPolicyEngine {
  constructor(
    public readonly preset: PolicyPreset = 'companion',
    private readonly approval?: ApprovalService,
  ) {}

  /** Resolve an operation to a concrete decision. "ask" never auto-passes. */
  async decide(op: MemoryOp): Promise<{ decision: PolicyDecision; asked: boolean }> {
    const rules = PRESETS[this.preset];
    let decision: PolicyDecision = rules[op.type];
    let asked = false;
    if (decision === 'ask') {
      // Fail-closed: without an approval service, unresolved asks are denials.
      // In headless preset the answer is a structural denial — no one is there to ask.
      if (this.preset === 'headless' || !this.approval) {
        decision = 'deny';
      } else {
        decision = await this.approval.request(op);
        asked = true;
      }
    }
    return { decision, asked };
  }
}
