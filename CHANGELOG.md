# Changelog

All notable changes to Dream. Versioning starts at 0.1.0 — the API will move
while the experiment suite keeps the behavior honest.

## Unreleased — hardening pass

### Correctness & live wiring
- Retrieval runs automatically on every turn; the OpenAI adapter now gets
  recalled nodes, bounded conversation history, and explicit `memory_recall` /
  `memory_correct` actions (previously live DeepSeek never recalled or corrected).
- Self-model is updated by dream cycles when skills form/refresh
  (`report.selfUpdates` is no longer always empty).
- Dream replay now re-strengthens important semantic facts, not just episodes.
- Forgetting default recalibrated from τ=90d to τ=180d: E3 now measures mean
  strength (0.26 vs 0.07 at day 180) instead of only a floor-count.
- Counterpoint updates re-embed the node; post-window corrections create a real
  association instead of an unlinked note.
- CJK tokenization + character n-grams; dimension mismatches are excluded rather
  than prefix-compared. Skill binding preserves case, strips trailing
  punctuation, and fails closed on article/anchor drift.
- Soft forget vs hard purge are now distinct; quarantine release exists.
- `DreamComponents.config` is honored; dream cycles are mutually exclusive.
- SQLite: WAL/busy timeout, batched edge fetch (N+1 removed), single decode in
  search.

### Security & multi-connection
- Gateway: loopback default, Origin allowlist, optional token, per-connection
  session + working memory, serialized turns, 1 MB frame cap, scrubbed read
  paths for timeline/forgetting bin/revive.
- Side-effect tools (MCP) fail closed without an approval service; explicit
  `--allow-side-effects` opt-in. MCP Windows spawn/stderr fixes.

### Evidence
- E1 acknowledges the persisted-path latency; E3 now truly tests zero manual
  practice and reports mean strength; E4 covers wording/case drift; experiment
  FAILs now fail CI.
- Test suite: 85 tests.

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
