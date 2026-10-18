import { z } from 'zod';

export const dreamConfigSchema = z.object({
  preset: z.enum(['companion', 'amnesiac', 'headless']).default('companion'),
  /** Owner partition for this kernel instance. */
  userId: z.string().min(1).default('default'),
  /** Emit stage-level trace events (counts/durations/hashes, never content). */
  traceEnabled: z.boolean().default(true),
  /** Persist trace events to the journal so `dream inspect` survives restarts. */
  tracePersist: z.boolean().default(true),
  /** Optional scene tag used as a retrieval prior (chat/working/coding). */
  scene: z.string().optional(),
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
  /** Weight of the BM25 lexical channel fused into activation (0 disables). */
  lexicalWeight: z.number().min(0).max(1).default(0.4),
  /** Minimum normalized BM25 score for a lexical candidate to enter activation. */
  lexicalMinScore: z.number().min(0).max(1).default(0),
  /** Entity/tag channel weight (names, identifiers, quoted titles). */
  tagWeight: z.number().min(0).max(1).default(0.15),
  /** Inactivity gap that starts a new discussion episode. */
  episodeGapMs: z.number().int().positive().default(30 * 60 * 1000),
  /** Extract rule-based typed edges (causal/contrast/temporal/elaborates/entity). */
  typedRelations: z.boolean().default(true),
  /** Same-episode support weight at recall (0 disables). */
  episodeWeight: z.number().min(0).max(1).default(0.1),
  /** Attach verbatim `details` to recalled nodes (addressable source values). */
  returnDetails: z.boolean().default(true),
  /** Attach exact artifact revisions to recalled nodes that reference them. */
  attachRevisions: z.boolean().default(true),
  /** Attach fact <-> experience links (TriLink) to recalled nodes. */
  attachTriLinks: z.boolean().default(true),
  /** Refuse skill replay when the current environment is outside its learned boundaries. */
  enforceSkillBoundaries: z.boolean().default(true),
  /** Match skills against mined search keys as well as the skill label. */
  useSkillSearchKeys: z.boolean().default(true),
  /** Cosine above which a near-duplicate is skipped when filling the working set. */
  retrievalDiversityThreshold: z.number().min(0.5).max(1).default(0.95),
  /** Memory kinds subject to the near-duplicate filter (episodic events stay distinct). */
  retrievalDiversityKinds: z
    .array(z.enum(['episodic', 'semantic', 'procedural', 'self']))
    .default(['semantic', 'procedural']),
  /** Kinds that get one working-set slot before rank-based filling. */
  retrievalReservedKinds: z
    .array(z.enum(['episodic', 'semantic', 'procedural', 'self']))
    .default([]),
  /** Optional per-kind working-set caps. */
  retrievalMaxPerKind: z.record(z.number().int().min(1)).optional(),
  /** Channel score fusion: interpolated activation (default) or reciprocal rank fusion. */
  retrievalFusion: z.enum(['interpolate', 'rrf']).default('interpolate'),
  /** RRF smoothing constant. */
  rrfK: z.number().int().min(1).default(60),
  /** Optional multiplicative priors by relation type during spreading. */
  retrievalRelationPriors: z.record(z.number().min(0).max(1)).optional(),
  /** Normalize spreading by sqrt(out-degree). */
  retrievalDegreeNormalize: z.boolean().default(false),
  /** Injection marker hits before content is quarantined on encode. */
  injectionThreshold: z.number().int().min(1).default(1),
  scrubSecrets: z.boolean().default(true),
  /** When true, closing a session with no pending input runs a dream cycle. */
  dreamOnSessionClose: z.boolean().default(false),
});

export type DreamConfig = z.input<typeof dreamConfigSchema>;
export type ResolvedDreamConfig = z.output<typeof dreamConfigSchema>;

export const defaultDreamConfig: ResolvedDreamConfig = dreamConfigSchema.parse({});
