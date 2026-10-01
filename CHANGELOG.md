# Changelog

All notable changes to Dream. Versioning starts at 0.1.0 — the API will move
while the experiment suite keeps the behavior honest.

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
