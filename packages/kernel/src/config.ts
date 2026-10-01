import { z } from 'zod';

export const dreamConfigSchema = z.object({
  preset: z.enum(['companion', 'amnesiac', 'headless']).default('companion'),
  wmCapacity: z.number().int().min(1).max(9).default(4),
  maxStepsPerTurn: z.number().int().min(1).max(50).default(8),
  maxToolCallsPerTurn: z.number().int().min(1).max(100).default(20),
  /** Minimum cosine between a task and a learned skill to run it implicitly. */
  skillSimilarityThreshold: z.number().min(0).max(1).default(0.78),
  skillMinSuccessRate: z.number().min(0).max(1).default(0.6),
  reconsolidationWindowMs: z.number().int().positive().default(10 * 60 * 1000),
  decayTauBaseMs: z.number().int().positive().default(90 * 24 * 60 * 60 * 1000),
  mergeThreshold: z.number().min(0.5).max(1).default(0.92),
  abstractionMinCluster: z.number().int().min(2).default(3),
  skillMinSuccessfulEpisodes: z.number().int().min(2).default(3),
  /** Dream replay re-strengthens important memories (see experiment E3). */
  replayStrengthens: z.boolean().default(true),
  replayStrengthensThreshold: z.number().min(0).max(1).default(0.7),
  /** Injection marker hits before content is quarantined on encode. */
  injectionThreshold: z.number().int().min(1).default(1),
  scrubSecrets: z.boolean().default(true),
  /** When true, closing a session with no pending input runs a dream cycle. */
  dreamOnSessionClose: z.boolean().default(false),
});

export type DreamConfig = z.input<typeof dreamConfigSchema>;
export type ResolvedDreamConfig = z.output<typeof dreamConfigSchema>;

export const defaultDreamConfig: ResolvedDreamConfig = dreamConfigSchema.parse({});
