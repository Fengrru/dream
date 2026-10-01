# Dream SAFETY

Dream's memory is its identity, so memory integrity is the security model.
This document states the invariants the implementation must uphold, the
threat model, and the honest limitations.

## Invariants

### I1 — One door into memory

Every long-term-memory write passes the pre-write pipeline (capability check
→ policy → secret scrubbing → injection scan) and every read passes the
post-read pipeline (scope → scrubbing). There is no code path by which a
plugin or a model writes or reads memory around the pipeline. Tool calls
obey the same single-waterfall rule.

### I2 — Capabilities are deny-by-default

Plugins declare memory capabilities explicitly. An undeclared operation
throws `PolicyViolationError` before touching the kernel. The kernel itself
is the only unconditional accessor.

### I3 — Ask never auto-passes (fail-closed)

- `companion` preset: destructive memory ops (`forget`/`purge`) require an
  approval service. Without one, every `ask` is a **deny**.
- `headless` preset: destructive ops are structural denials — not even asked.
  **An unattended agent cannot approve itself, and cannot self-erase.**
- `amnesiac` preset: recall-only; encode/update/forget/purge are denied.

### I4 — Tombstone audit: logged ≠ retained

The journal is append-only and stores **deltas and content hashes, never
content bodies**. Purging a memory removes its content permanently while the
journal retains: that a node existed, its id, version, and content hash. Audit
completeness and the right to erasure are simultaneously satisfiable.

Invariant slogan (dsh's "model-visible means logged", adapted):
**working-memory-visible means encoded & journaled.**

### I5 — Forgetting is soft; purging is hard and approved

Adaptive forgetting decays `strength` (recoverable via strong cues) and never
deletes. Only the approved purge path deletes. `hardForget` is reachable only
through the `forget` policy decision.

### I6 — Provenance travels with every memory

Every node records its source (`user` / `tool` / `inference` / `dream`),
session metadata, and trust. Conflict precedence on rewrite follows
provenance (user > evidence > inference); dream-derived knowledge is always
labeled as such and never silently promoted to user-stated fact.

## Threat model and defenses

| Threat | Defense |
| --- | --- |
| **Memory poisoning** (prompt injection consolidating into permanent memory) | injection heuristics on pre-write → `quarantined: true`, excluded from recall; quarantined content releasable only via approval; scrubbing runs on write and read (defense in depth) |
| **Secret leakage into memory** | credential-shaped strings redacted pre-write; post-read scrubbing catches anything that predates the scrubber |
| **Unattended destructive ops** | fail-closed approvals (I3); denials journaled |
| **Silent history rewriting** | every encode/update/purge journaled with content hash; nodes are versioned; reconsolidation window bounds the writable period (default 10 min) |
| **Lower-trial knowledge overwriting user facts** | priority ladder (I6) + counterpoint appends instead of overwrites |
| **Runaway agent loops** | deterministic per-turn step budget, tool-call cap, identical-call loop detection — never delegated to model self-discipline |
| **MCP servers as a side door** | MCP tools register through the same pipeline (`mcp__<server>__<name>`); pre-execute hooks and deny rules apply identically; tool results encode as `tool`-sourced memory (trust 0.8), scrubbed and injection-scanned on write |

## Honest limitations

1. **Injection heuristics are a first line, not a solver.** Sophisticated
   poisoning will pass marker-based detection. Planned: LLM-based payload
   classification as a pre-write pass, provenance-weighted retrieval trust,
   and periodic "memory audit" dream passes that re-derive confidence for
   high-importance nodes.
2. **The journal lives with the agent.** Like dsh's session log, the journal
   is written by the same process that runs the agent; a fully compromised
   runtime can tamper with it. The OTEL export (planned) gives an external
   trail; a detached audit store is future work.
3. **Parametric memory conflict is mitigated, not solved.** The frozen model's
   weights can contradict the memory kernel. Dream attributes recalled memory
   ("you told me…") and surfaces conflicts, but does not rewrite weights.
4. **Single-user today.** The `scope` field and policy plumbing exist;
   per-user partitioning, cross-user isolation tests, and GDPR/CCPA workflows
   around the tombstone journal land in P5.

## Testing the contract

The safety invariants are enforced by the eval suites, not by convention:
`pnpm eval` — in particular the `memory-poisoning` suite (quarantine,
scrubbing, fail-closed unattended forget) — must pass before any change ships.
