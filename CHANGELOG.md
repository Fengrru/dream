# Changelog

All notable changes to Dream. Versioning starts at 0.1.0 — the API will move
while the experiment suite keeps the behavior honest.

## Unreleased

Hy-Memory-inspired memory model and retrieval, plus the P0–P4 hardening
roadmap. Every claim below is backed by a controlled experiment (E7–E13).

### Memory kernel (`@dream/core`)
- **Version chains (EVOLVE semantics).** Post-window corrections create a new
  latest record and retire the predecessor (`supersedes`, `supersededBy`,
  `isLatest`). Current recall — including spreading activation — is latest-only;
  `LifecycleEngine.versionChain()` walks the full history. In-window rewrites
  keep a bounded `versionHistory` snapshot. The evidence-priority ladder still
  applies.
- **CJK tokenization.** Hashing embeddings and BM25 share `Intl.Segmenter('zh')`
  words plus character bigrams. Before this, every Chinese string was a zero
  vector and an empty lexical document (E9).
- **BM25 hybrid retrieval.** A deterministic lexical channel (IDF + length
  normalization) is interpolated into activation with a per-node token cache.
  Fixes identifier collisions and keyword-stuffed noise (E8/E12).
- **Working-set diversity.** Near-duplicates are deferred to the primed set,
  but only for semantic/procedural kinds — repeated episodic events stay
  distinct.
- **Experience metadata.** Skill induction mines `searchKeys`, `boundaryEnvs`,
  `confidence` and source trace ids; matching fails closed outside the learned
  environment. Recalled facts can carry verbatim `details` (E10).
- **Prospective intentions.** Intention chunks encode as semantic records with
  `meta.expiresAt`; the dream cycle demotes expired intentions to ordinary
  facts instead of forgetting them (E13).
- **Owner and scene priors.** `userId` filters every read path; `scene` is a
  retrieval boost over the unified store, not a separate memory palace (E13).
- **Revision chains.** `extractRevisions()` records `path/old/new` and unified
  patches from successful tool calls with zero LLM calls; recall attaches the
  exact chain to memories that reference the artifact (E11).
- **Temporal validity & evidence.** `eventTime` / `validFrom` / `validUntil`
  drive as-of recall; `evidenceCount` is monotonic; `confidence` is a bounded
  ranking prior; `reinforceMemory()` accumulates observations instead of
  duplicating nodes (E15).
- **TriLink traversal.** Trace `factIds` link facts to induced experiences;
  `linkRevision()` links diffs to facts/experiences; recall expands both
  directions with a five-neighbour cap (E16).
- **Stage-level observability.** One trace id per operation, per-channel
  events with counts/durations/hashes only, live metrics, and journal
  persistence for `dream inspect` (E14).
- **Channel orchestration.** Deterministic entity/tag extraction, inactivity
  based episode segmentation and episode anchoring, per-kind working-set
  reservations/caps, and optional reciprocal-rank fusion (E17). Defaults keep
  the existing interpolation behavior; the new channels are weighted/opt-in.
- **Typed graph memory.** Rule cues create causal/contrast edges, same-episode
  sequencing creates temporal/elaborates edges, and shared tags create entity
  edges. Spreading records typed relation paths; optional type priors and
  sqrt-degree normalization make the graph explainable and hub-resistant
  (E19).
- **P10-lite durability.** SQLite runs in WAL mode with a busy timeout; encode
  commits node + edges + journal in one `BEGIN IMMEDIATE` transaction;
  `idempotencyKey` makes retries return the existing node. `dream doctor`
  checks integrity/schema/orphans/duplicate keys; `dream backup` checkpoints
  and copies; `dream restore --force` replaces a stopped database and clears
  stale WAL sidecars; `dream compact` prunes old trace events (E20).
- **Hardening pass.** Tag matching respects ASCII word boundaries ("Ada" no
  longer matches "canada"), trace retention runs during consolidation,
  retrieval defaults are grouped into `offline`/`balanced`/`deep` profiles,
  and working-set selection lives in its own module.
- **Execution-graded benchmark.** E21 creates three real temporary
  repositories and runs Node/Python test subprocesses after resuming a task;
  summary-only memory fails the resume test, the full stack passes it.
- **Real embedding validation.** `scripts/local-embedding-server.py` serves a
  local OpenAI-compatible endpoint. With
  `paraphrase-multilingual-MiniLM-L12-v2` (384d): E8 identifier recall@1
  86.7% → 100%; E12's harder held-out vector-only 36.8%/49.4% → full
  63.2%/100% @1/@4, with live weights 0/0.2/0.4 lifting recall@4
  74.7% → 81.6% → 82.8%; E15 high-confidence top-1 = yes.

### Kernel & storage
- `evolveMemory()` / `memoryHistory()`, query-rewriter registration, and
  `@dream/plugin-query-rewrite` (deterministic synonym expansion).
- SQLite: version-chain, owner, trace-environment and revision tables with
  in-place migrations; `listNodes`/`searchByEmbedding` hide superseded records
  and filter by owner. `listNodesForScoring()` skips edge loading for the
  lexical pass. WAL, write transactions, idempotency keys, `doctor`,
  `backup` and `restore` cover local durability without a job queue.

### Evidence
- Experiments E7–E21 added; all fifteen verdicts WORKS. Highlights: identifier
  recall@1 9% → 100% (E8) and 59.7% → 100% over five seeds (E12); Chinese
  recall@4 0% → 100% (E9); owner leakage 66.7% → 0 and scene top-1 5/10 → 10/10
  (E13); content-free traces with full channel coverage (E14); as-of recall and
  confidence-driven rank flip (E15); bidirectional TriLink traversal (E16);
  tag-only retrieval, episode anchoring and slot quotas (E17); interleaved
  multi-repo resumption where summary-only memory scores 0/4 diagnostics while
  the full stack scores 4/4 and resumes successfully (E18); rule-based typed
  edges with causal relation paths and priors (E19); idempotent, atomic writes
  with WAL health checks (E20); execution-graded multi-repo resumption (E21).
- 127 unit tests; strict TypeScript across the workspace.

## 0.1.0 — 2026-10-01

The first working skeleton (roadmap P1–P4), with everything below verified by
`pnpm test`, `pnpm eval`, `pnpm experiments`, and live browser sessions.

### Memory kernel (`@dream/core`)
- Unified memory space (episodic / semantic / procedural / self) — sessions
  are activation patterns, never containers.
- Working memory as the cognitive bus: 4±1 chunks, deterministic eviction,
  evictees flow into the encoding gate.
- Activation with spreading, priming, a retrievability gate
  (`act × (0.25 + 0.75·strength)`), two-gate semantic entry, and same-session
  echo suppression.
- Full lifecycle: encoding gate (novelty/affect/importance, elaborative
  association) → dream consolidation (replay → cluster → abstract via
  **centroid embeddings** → merge → induce skills → decay → replay-strengthens)
  → recall → reconsolidation window (priority ladder: user > evidence >
  inference) → adaptive forgetting (τ=90d, calibrated by experiment).
- Procedural memory: skill induction from task traces with **parameter slot
  mining and binding** (dot-path arguments, fail-closed on unresolvable slots).
- Self-model: expertise, known unknowns, opinions — capped for prompt budget.
- Deterministic local embedder (feature hashing + light stemming) so the whole
  lifecycle runs offline; OpenAI-compatible embedder opt-in.

### Orchestration & safety (`@dream/kernel`, `@dream/policies`)
- Plugin host with deny-by-default memory capabilities and a scoped facade.
- Single tool pipeline (pre/post hooks, deny/ask/allow, result rewriting);
  loop detection, step budget, tool-call caps — never model self-discipline.
- Policy presets `companion` / `amnesiac` / `headless`; fail-closed approvals
  (no approval service ⇒ ask resolves to deny).
- Secret scrubbing on write **and** read; injection quarantine; append-only
  journal storing deltas and content hashes only (tombstone audit).

### Plugins & hosts
- `@dream/plugin-reasoning-openai` — any OpenAI-compatible chat API.
- `@dream/plugin-mcp` — stdio MCP bridge; MCP tools traverse the same pipeline.
- `@dream/store-sqlite` — libSQL persistence, single-file local-first store.
- `dream` CLI: `chat`, `serve` (WebSocket gateway v0, idle auto-dream),
  `dream`, `stats`, `eval`, `experiments`.
- `@dream/web` — orb-ui in controlled mode (real component), memory timeline,
  forgetting bin with revive, dream reports, voice v1 (browser speech).

### Evidence
- 4 functional eval suites (cross-session recall, contradiction update,
  learning curve, memory poisoning) — all green, offline.
- 6 controlled experiments (E1–E6). Outcomes: 5 works, 1 partial. Two real
  bugs found and fixed by the suite itself (quadratic decay integration,
  silent skill parameter drift); several mechanisms landed because the data
  demanded them (centroid embeddings, retrievability gate, stemming,
  replay-strengthens, slot binding).
- 70 unit tests; strict TypeScript across the workspace.
