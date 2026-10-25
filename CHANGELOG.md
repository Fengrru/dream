# Changelog

All notable changes to Dream. Versioning starts at 0.1.0 — the API will move
while the experiment suite keeps the behavior honest.

## Unreleased — audit hardening pass

A full code audit found ~60 issues across three crash vectors, contract
violations, and eval-gate gaps. All are fixed in this pass.

### Crash vectors (all were one-frame/one-server process kills)
- Gateway: a non-string `text` field on a `chat` frame threw synchronously in
  the message handler and killed the process; now strictly typed with an error
  frame back to the client.
- Gateway: no `error` listener on connections (invalid UTF-8, >1 MB frame, TCP
  reset) or on the server itself — any of those crashed the process. Both are
  handled now.
- MCP: no `error` listener on the server's stdin, and the child handle stayed
  set after exit — a dead MCP server crashed the host on the next tool call.
  Stdin errors are caught; exits null the handle.

### Memory kernel (`@dream/core`)
- Skill induction now enforces the documented "same step sequence" gate: the
  most-frequent successful sequence must itself appear ≥ N times, not just the
  task total (previously three successes with three different sequences induced
  a skill from one arbitrary trace, replayed with zero LLM calls).
- `decayPass` advances a dedicated `lastDecayedAt` decay reference — it no
  longer overwrites `lastAccessedAt`, which flattened the episodic recency cue
  after every dream cycle.
- Episodic and procedural activation now clear the priming floor, and the
  working set admits only above-floor nodes — unrelated queries no longer
  displace focal content. The procedural threshold is configurable.
- Spreading activation combines same-layer hits by max instead of
  last-write-wins.
- Slot binding fails closed when the two anchors are adjacent (empty slot) —
  the after-anchor can no longer be bound as the argument value.
- `WorkingMemory.tick()` is idempotent (own decay reference, like decayPass).
- Empty content is rejected by the encoding gate (was: unmatchable dead node).
- `setOpinion` journals; self-model recall excludes quarantined/faded nodes;
  the displayed confidence is the clamped value.
- OpenAI embedder stops retrying deterministic dimension errors via a typed
  non-retriable error class; no final backoff sleep after the last attempt.
- Counterpoint appends are bounded (history capped in `meta.counterpoints`);
  `mergedCount` counts unique merged nodes, not pairs.

### Orchestration (`@dream/kernel`)
- Plugin `apply()` failures roll back the registration; hook exceptions fail
  closed (pre-hook → deny, post-hook → pass-through) instead of aborting the
  turn unjournaled.
- `memory/encode` bus events require the `recall` capability to subscribe;
  quarantined content is not broadcast; `tool/execute` events no longer carry
  tool arguments.
- Corrections (`memory_correct` and the `correct` thought) degrade to linked
  notes on policy denial or missing node instead of throwing out of `submit()`
  and dropping the user's message.
- Per-session turn serialization (`submit` chains), a tool-cap stop message
  instead of silent empty re-asks, order-independent loop-detection keys, and
  skill replay bounded by the per-turn tool-call budget.
- MCP tool input schemas are injection-scanned; flagged schemas are reduced to
  their structural skeleton (the description was already withheld — the schema
  prose was not).
- Multiple reasoning strategies log a warning (first stays default); memory
  facade ops carry `pluginId` into policy journal entries.
- Failed MCP tool registrations roll back (no zombie tools pointing at a dead
  client); `tools/list` pagination is followed.
- reasoning-openai: unparsable tool-call arguments are rejected, not executed
  with `{_unparsed}`; mixed memory + regular call batches dispatch everything
  (nothing silently dropped); 429/5xx bodies are drained; the plugin no longer
  declares memory capabilities it never uses.

### Persistence (`@dream/store-sqlite`)
- `deleteNode` removes both edge directions in one write batch — no orphaned
  edges after merges/purges.
- `busy_timeout` is set before schema creation (two processes racing init no
  longer hit SQLITE_BUSY on CREATE TABLE); migrations rethrow everything except
  duplicate-column errors; `lastDecayedAt` round-trips (new column + migration).
- `listNodes` fetches edges only for the returned ids (chunked IN queries) —
  no full-table edge scan per UI poll. Tests now assert float32 embedding
  round-trip values, not just shape.

### Gateway & CLI
- Gateway: timing-safe token comparison (hashed), ping/pong liveness with
  dead-peer termination, manual `dream` frames refused while a turn is
  in-flight (same rule as the idle path), fragmented WS frames concatenated
  before JSON.parse, min-interval drops now send an explicit error frame,
  encode events are routed to the owning connection instead of broadcast, and
  task failures log internally while telling the client a neutral message.
- CLI: `.env` is searched upward from the cwd with quote stripping; `--flag
  false` parses as false (was `Boolean('false')` = true); a bare
  `--embed-dimensions` errors instead of requesting dimension-1 embeddings;
  the listen log reports the actual bound port.

### Web UI
- Panel fetches moved out of the setState updater (StrictMode double-fire);
  the mic stops when switching signal source or unmounting; send() only clears
  the input when the frame was actually delivered and reports dropped frames;
  the `?token=` query param is scrubbed from the URL after connect; the orb
  resets to idle on disconnect.

### Evidence
- E6's verdict is derived from the measured prompt growth and live ratio
  (previously hard-coded `'works'` — the experiment could not fail). The CI
  gate now breaks on any verdict short of WORKS: four of six experiments could
  only ever reach PARTIAL, so recall-quality, consolidation and forgetting
  regressions used to pass green. E1's headline claim is conditional on the
  data; E3's narrative numbers are computed, not prose; the runner no longer
  claims wall-clock latency measurements are deterministic.
- Injection heuristics weight markers (strong = 2, weak = 1) so ordinary
  phrases like "you are now" no longer quarantine alone; secret scrubbing
  orders specific key formats first (Anthropic keys were mislabeled as OpenAI)
  and adds Google/Slack/private-key patterns.
- `packageManager` field pins pnpm (CI pinned pnpm 12 against a v9 lockfile
  with no local pin); gateway coverage added (fuzz + protocol tests).
- Test suite: 100+ tests.

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
