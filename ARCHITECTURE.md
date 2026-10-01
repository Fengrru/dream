# Dream Architecture

Dream implements one thesis: **an agent's kernel should be its memory system,
not its reasoning loop.** Reasoning models are organs — rented, replaceable.
Memory is the organism.

This document covers the design and its rationale. The safety contract lives
in [SAFETY.md](./SAFETY.md).

---

## 1. Three inheritances, one inversion

| Source | Inherited | Changed |
| --- | --- | --- |
| Cognitive science | memory taxonomy (working / episodic / semantic / procedural / self), lifecycle (encode → consolidate → retrieve → reconsolidate → forget), spreading activation & priming, attention-limited working memory | implemented functionally, not structurally — no neuron cosplay |
| dsh (DeepSeek Harness) | single-pipeline tool interception, plugin capability model, fail-closed approvals, honest preset naming, append-only session audit | the kernel is **not empty**: memory is a privileged core, the one thing that is not a plugin |
| orb-ui | the `<Orb>` component, controlled mode (`signal` prop), adapter pattern | the orb is driven by *cognitive* state (working-memory load, recall ripples, dreaming), not just voice I/O |

**The inversion.** dsh says "Everything is a Plugin" from an empty kernel.
Dream says it from a full one: the memory kernel is privileged and
non-replaceable; plugins read and write it only through the working-memory
bus, under policy. Identity, learning, and skill live in the kernel; the
reasoning model is a callable organ.

## 2. The memory kernel (`@dream/core`)

### 2.1 Unified memory space

One node-edge store, four kinds, **no session isolation** — a session is
metadata, never an isolation key:

```ts
interface MemoryNode {
  id; kind: 'episodic' | 'semantic' | 'procedural' | 'self';
  scope: 'user' | 'agent';
  content; embedding; edges: Association[];
  provenance: { source: 'user'|'tool'|'inference'|'dream'; sessionId?; trust };
  importance; strength;            // salience vs retrievability
  labileUntil?; consolidatedAt?;   // reconsolidation window, dream bookkeeping
  version; quarantined?;
}
```

- **Forgetting = strength decay**, never deletion (strong cues can revive);
  **purge** is the only hard delete and leaves a tombstone in the journal.
- **Conflict precedence** on rewrite: user > evidence > inference. The base
  priority derives from provenance; a lower-priority update is appended as a
  counterpoint rather than overwriting.

### 2.2 Working memory = the cognitive bus

Capacity is hard-limited (4±1 chunks). Chunks are *pointers* into long-term
memory, so the limit bounds attention focus, not accessible information.
Eviction is deterministic (least-active chunk) and the evictee flows to the
encoding gate — attention lapse is how material reaches long-term memory.
Plugins never talk to each other directly; the working memory is the exchange
medium. This is the deepest deviation from dsh's event-bus coupling.

### 2.3 Retrieval = activation, not search

`ActivationEngine` pre-activates a subset of the space from context seeds:

1. semantic/self nearest concepts (two-gate entry: a lenient raw-similarity
   floor plus the gated salience clearing the priming floor),
2. spreading activation over the association graph (depth 2, weighted edges),
3. episodic similarity blended with recency,
4. procedural skills matching the inferred task.

Two calibration results from the experiment suite are baked in:

- **Retrievability gates activation** (`act × (0.25 + 0.75·strength)`).
  Experiment E3's decay story only became real for recall once faded
  memories were harder to activate, not just harder to find in the store;
  the 0.25 floor keeps the "strong cues can revive" promise.
- **Abstractions are centroid-embedded.** A dream-created semantic node's
  embedding is the normalized centroid of its cluster, so pattern-level
  queries land on it in the same space as the episodes it summarizes
  (experiment E2), and its salience blends similarity with importance
  (0.75/0.25) so it outranks any individually-recency-boosted episode.

The result splits into a **working set** (enters focus) and a **primed set**
(activated but unfocused — lowered threshold for later cues, the digital
analogue of priming). Same-session episodic residues are excluded from recall
(conscious contents don't need to be "recalled"); semantic facts and skills
formed this session remain recallable.

The default local embedder stems English suffixes (`reviews`→`review`) —
experiment E2 showed unstemmed feature hashing scoring query-vs-abstraction
similarity just below usable thresholds.

Retrieval practice marks accessed nodes: strength up, and a **reconsolidation
window** opens (default 10 min) during which the memory may be rewritten in
place. After the window, updates are rejected — the caller is told to encode a
linked note instead.

### 2.4 The lifecycle engine = the learning engine

- **Encoding gate**: novelty scoring, affect heuristic, importance weighting,
  elaborative association (edges to nearest existing memories), provenance binding.
- **Dream cycle** (idle-time consolidation): replay unconsolidated episodes →
  cluster → abstract semantic patterns (`Pattern: …` nodes, provenance
  `dream`) → merge near-duplicates → **induce skills** from task traces →
  decay pass → self-model update → emit a `DreamReport` (the product's
  flagship "morning ritual").
- **Skill induction**: ≥ 3 successful traces of a task type with the same step
  sequence → a procedural node carrying a strategy (tool + args steps) and an
  EMA success rate. **Parameter slots** are mined at induction: each string
  argument located inside the training percepts becomes a slot (anchor tokens
  around the value). At execution the slots are refilled from the incoming
  request; any unresolvable slot fails CLOSED — the executive skips the skill
  and falls back to explicit reasoning rather than replaying stale arguments
  (experiment E4: silent wrong-arg replays 6/6 → 0/6). Replay runs **without
  any LLM call**. The dream cycle's replay also re-strengthens memories at
  importance ≥ 0.7 (retrieval practice — experiment E3 showed critical
  memories otherwise decay to unrecoverable within months).
- **Self-model**: `kind: 'self'` nodes — expertise confidence, known unknowns,
  opinions — updated by dream cycles, injected into reasoning prompts, so the
  agent is the same person in every session.

## 3. Orchestration (`@dream/kernel`)

### 3.1 Plugins and capabilities

A plugin declares its memory capabilities explicitly
(`{ encode, recall, update, forget, purge, selfRead }`). The scoped facade
**denies by default**: an undeclared operation throws before touching the
kernel. Tools register through the context; one reasoning strategy is the
explicit thinker; dream passes extend consolidation.

### 3.2 The single pipeline

Every tool call traverses one waterfall: pre-execute hooks (allow / deny /
ask) → handler → post-execute hooks (result rewrite before the model sees
it). `ask` with no approval service resolves to **deny** — fail-closed, the
dsh rule. Denials are journaled.

Memory gets the same treatment: pre-write hooks (secret scrubbing, injection
quarantine) → policy → encode; recall results pass post-read hooks (scrub
again) before any model sees them. There is no second door into memory.

**MCP tools are not an exception.** `@dream/plugin-mcp` speaks JSON-RPC 2.0
over stdio to MCP servers, runs the initialize handshake, and registers each
server tool as `mcp__<server>__<name>` through `ctx.tools.register` — so MCP
calls traverse the identical waterfall, hit the same pre-execute policy hooks,
appear in the same journal, and respect the same loop detection. A policy
plugin that denies `mcp__*` denies all of them; no server can smuggle a tool
around the pipeline.

### 3.3 The executive

No monolithic control loop. Per turn:

1. percept enters working memory (evictee encodes; explicit user facts encode immediately as semantic),
2. **skill match** (taskType exact, or similarity ≥ threshold with success rate ≥ threshold) → replay strategy steps implicitly, record trace, done — zero reasoning calls,
3. otherwise the reasoning strategy reads the WM snapshot (+ recalled nodes + self-model summary) and returns one of:
   - `final` — attends a conclusion chunk,
   - `tool_calls` — executed through the pipeline, results attend as chunks,
   - `recall` — activation fires, results attend (opening reconsolidation windows),
   - `correct` — in-place rewrite of a labile memory.

Deterministic guardrails that never depend on model self-discipline: per-turn
step budget, per-turn tool-call cap, and identical-call loop detection
(3 repeats → hard stop with a `[SYSTEM]` message and a failure trace).

Traces: any turn with tool calls records `{taskType, steps, outcome}` — the
raw material of procedural induction.

## 4. Security (`@dream/policies`)

See [SAFETY.md](./SAFETY.md) for the contract. Summary: deny-by-default
capability model; permission presets `companion` / `amnesiac` / `headless`
(named honestly); fail-closed approvals; secret scrubbing on write *and*
read; injection heuristics quarantining suspected payloads (excluded from
recall, releasable only via approval); tombstone audit via a content-hash
journal (purged memories leave a hash, never a body).

## 5. Persistence (`@dream/store-sqlite`)

libSQL/SQLite, local-first: the whole memory system is one file the user owns,
inspects, backs up, and deletes. Vector search is a filtered brute-force scan
over L2-normalized embeddings — correct and fast at personal-agent scale
(10⁴–10⁵ nodes); the upgrade path is sqlite-vec virtual tables behind the same
`MemoryStore` port. The in-memory store implements the same three ports
(memory / journal / traces), which is what makes the eval harness fully
deterministic and offline.

## 6. Interaction (`@dream/web` + gateway)

The gateway (`dream serve`, WebSocket protocol v0 on `ws://127.0.0.1:7333`)
bridges the kernel to the browser: state/cognitive frames, replies with
recalled memories, encode events, dream reports, plus on-demand
`memories` / `forgetting-bin` / `revive` frames. With `--idle-dream <sec>`,
inactivity triggers a real consolidation cycle — Dream sleeps when you leave
it alone, and the dream report lands in the UI when you return.

orb-ui in **controlled mode**: Dream's cognitive state machine (idle /
listening / thinking / speaking / **dreaming** / **recalling** / error) drives
the orb signal; working-memory load modulates intensity. Panels: dream log,
memory timeline, **forgetting bin with revive** (soft-forgotten memories,
strong-cue recovery), dream report. **Voice v1** uses browser-native speech
(recognition in, synthesis out — zero deps); the streaming v2 path is
Pipecat / OpenAI Realtime behind orb-ui adapters. A `mock` signal source
(same simulation engine as the orb-ui demo) keeps the page alive without a
gateway.

## 7. Implementation choices

- **Internal-packages monorepo**: workspace packages export TypeScript
  sources directly (JIT style); tests and apps resolve sources via aliases.
  Add a bundling build step before publishing to npm.
- **Zero-dependency core**: `@dream/core` uses only node builtins — the whole
  lifecycle runs offline with the deterministic hashing embedder, which is why
  evals need no API keys.
- **dsh compatibility is at the convention level** (plugin names, preset
  philosophy, pipeline semantics), not a fork: dsh is in developer preview
  with declared breaking changes. Porting dsh-ecosystem plugins is designed to
  be cheap; adopting the Cordis kernel itself is an adapter away if needed.
- **Provider-agnostic**: embeddings and reasoning are interfaces; OpenAI
  providers are reference implementations behind env config.

## 8. Known limits (honest section)

1. **Parametric vs external memory.** The frozen model weights are themselves
   semantic memory and can contradict the memory kernel. Dream mitigates by
   provenance-tagged injection ("you told me…") and explicit conflict
   surfacing; it does not pretend the problem is solved.
2. **Credit assignment v1.** Skill evolution consumes only hard signals
   (tool success/failure, explicit traces). richer reward models are future work.
3. **Embeddings.** The offline hashing embedder is shallow; with a real
   embedding provider, thresholds (0.45 association, 0.55 clustering, 0.78
   skill match, 0.92 merge) must be re-tuned via the eval suites — that is
   exactly what `@dream/eval` exists for.
4. **Single-agent, single-writer.** Multi-user scoping is designed
   (`scope` field, per-user partitioning planned P5) but not yet enforced.
