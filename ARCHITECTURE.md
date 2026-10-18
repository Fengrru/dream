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
  version;
  supersedes?; supersededBy?;      // version chain (immutable history)
  isLatest?;                       // current version flag; recall is latest-only
  quarantined?;
}
```

- **Forgetting = strength decay**, never deletion (strong cues can revive);
  **purge** is the only hard delete and leaves a tombstone in the journal.
- **Conflict precedence** on rewrite: user > evidence > inference. The base
  priority derives from provenance; a lower-priority update is appended as a
  counterpoint rather than overwriting.
- **Version chain = correction without destruction** (EVOLVE semantics, after
  Hy-Memory). Once the reconsolidation window closes, a correction creates a
  new latest record and retires its predecessor (`isLatest: false`,
  `supersededBy`). Current recall is latest-only — spreading activation skips
  retired versions too — while `versionChain()` walks the full ancestry.
  History is data, not a second answer competing for attention.
- **Temporal validity and evidence.** `eventTime`, `validFrom`/`validUntil`
  are stored separately from `createdAt`/`lastAccessedAt`; recall can ask
  "what was true at time T" and exclude stale or not-yet-valid versions.
  `evidenceCount` is monotonic and `confidence` is a bounded ranking prior;
  `reinforceMemory()` accumulates observations instead of creating duplicates
  (E15).

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
4. procedural skills matching the inferred task,
5. a **BM25 lexical channel** fused with the vector activation (weight 0.4
   by default). Hashed embeddings rank by token overlap without IDF or length
   normalization: exact identifiers collide and repetitive logs win. The
   lexical channel interpolates toward the BM25 score, which both lifts the
   exact match and demotes the high-vector/low-lexical neighbor (E8).
6. **CJK tokenization.** The hashing embedder and BM25 share one tokenizer:
   `Intl.Segmenter('zh')` words plus character bigrams (E9). Without it every
   Chinese string was a zero vector; segmentation alone is brittle across
   paraphrases, bigrams alone lose word-level IDF.
7. **Owner and scene priors.** `userId` filters every channel (semantic,
   episodic, procedural, spreading, lexical), so partitions are real without
   splitting the store (E13). `scene` only boosts matching tags; it is a
   retrieval prior, not a separate memory palace.
8. **Entity/tag channel.** Deterministic surface entities (capitalised names,
   identifiers, quoted titles) plus caller-supplied tags nominate memories
   whose wording differs from the query (E17). No NER model, no extra write.
9. **Episode support.** Encoding segments discussions by inactivity (default
   30 min). Recall anchors on the strongest hit's episode and boosts its
   neighbours, so resuming a topic brings the surrounding context (E17).
10. **Channel orchestration.** A working-set selection pass can reserve one
    slot per requested kind and cap a kind, preventing a large semantic
    cluster from starving skills or episodes. `fusion: 'rrf'` optionally
    switches from interpolated scores to reciprocal-rank fusion across
    semantic/episodic/procedural/lexical/tag channels; the default remains
    interpolation for stability (E17).
11. **Named profiles.** `offline`, `balanced` and `deep` bundle the channel
    defaults (lexical/tag/episode weights, RRF, reservations, type priors,
    degree normalization); explicit config knobs override the profile. This
    keeps the cost/quality trade-off legible instead of exposing a dozen
    independent switches.
12. **Typed graph.** At encode, rule cues create `causal`/`contrast` edges,
    same-episode sequencing creates `temporal`/`elaborates` edges, and shared
    tags create `entity` edges. Spreading records a `RelationStep` path, and
    optional type priors plus sqrt-degree normalization keep hub nodes from
    dominating. The cue extractor is deterministic; a missed cue degrades to
    the ordinary similar edge (E19).

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

Filling the working set runs a **diversity pass**: a candidate whose embedding
is a same-kind near-duplicate (cosine > 0.95) of an already-selected memory is
deferred to the primed set. Four paraphrase copies of one fact should not
consume the four slots that could hold four distinct memories (E8).

The default local embedder stems English suffixes (`reviews`→`review`) —
experiment E2 showed unstemmed feature hashing scoring query-vs-abstraction
similarity just below usable thresholds.

Retrieval practice marks accessed nodes: strength up, and a **reconsolidation
window** opens (default 10 min) during which the memory may be rewritten in
place. After the window, in-place rewrites are rejected; the executive instead
creates a **new latest version** and retires the old one, so the correction
wins recall while the ancestry stays auditable (E7).

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
- **Experience metadata.** Induction also mines `searchKeys` from successful
  percepts, `boundaryEnvs` from trace environments, a confidence score and the
  source trace ids. Matching checks boundaries first and **fails closed** when
  the current environment is outside them (E10); search keys let a paraphrased
  request match a skill whose label alone would not. Recalled facts may carry
  verbatim `details` outside the embedding field, so summaries stay findable
  while exact values stay readable.
- **Episode segmentation.** The encoding gate assigns an `episodeId` by
  inactivity (default 30 min) unless the caller provides one, so consolidation
  can treat "the same discussion across sessions" as one unit instead of
  clustering by embedding alone (E17).
- **Prospective intentions.** `kind: 'intention'` encodes as a semantic record
  with `meta.expiresAt` and a small retrieval boost. The dream cycle demotes
  expired intentions to ordinary facts (E13): the reminder stops firing, the
  information is not forgotten.
- **Self-model**: `kind: 'self'` nodes — expertise confidence, known unknowns,
  opinions — updated by dream cycles, injected into reasoning prompts, so the
  agent is the same person in every session.

### 2.5 Revision chains = the history a summary drops

Tool calls are the ground truth of what changed. `@dream/core`'s
`extractRevisions()` reads deterministic edit shapes (`path/old/new` writes and
unified patches) from **successful** tool calls and appends them to a revision
chain keyed by artifact. No LLM is involved, so a diff cannot be hallucinated
and failed edits never enter history (E11). Recall attaches the chain to any
memory whose `meta.artifactKeys` names the artifact; the reasoner sees exact
versions instead of a paraphrase. The `RevisionStore` port is implemented by
the in-memory and SQLite stores; it is deliberately separate from the four
memory kinds — revisions are evidence, not memories.

The three layers are explicitly linked (TriLink, E16): traces carry `factIds`,
skill induction writes `skill.sourceFactIds` and backfills
`fact.derivedExperienceIds`, and `linkRevision()` writes the revision's
`sourceFactIds`/`derivedExperienceIds`. Recall expands the graph in both
directions, capped at five neighbours per layer, so a fact can surface the
experience it produced and the exact diff it led to without blowing the
working-set budget.

## 3. Orchestration (`@dream/kernel`)

### 3.1 Plugins and capabilities

A plugin declares its memory capabilities explicitly
(`{ encode, recall, update, forget, purge, selfRead }`). The scoped facade
**denies by default**: an undeclared operation throws before touching the
kernel. Tools register through the context; one reasoning strategy is the
explicit thinker; dream passes extend consolidation. A plugin may also register
a **query rewriter** (`ctx.retrieval.addQueryRewriter`) — the kernel applies it
before activation and falls back to the previous query on failure.
`@dream/plugin-query-rewrite` ships a deterministic synonym/abbreviation
expander, so recall improves offline; an LLM rewriter can implement the same
interface in its own plugin.

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

### 3.4 Observability

Every encode/recall/dream/tool operation gets one `traceId`. Activation emits
one event per channel (`embed`, `semantic`, `episodic`, `procedural`,
`lexical`, `spread`, `dedup`), and the kernel adds `recall`, `encode`,
`query-rewrite`, `revision`, `tool` and `dream` events plus durations. Events
carry counts, hashes and lengths — **never content** — so they are safe to
persist in the journal and print. `kernel.traceEvents()`/`traceMetrics()` serve
the live view; `dream inspect --trace <id>` (and `--metrics`/`--json`) reads the
journal after a restart. E14 verifies continuity, channel coverage, privacy
and persistence.

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
`MemoryStore` port. The in-memory store implements the same four ports
(memory / journal / traces / revisions), which is what makes the eval harness
fully deterministic and offline. Nodes carry `userId` (owner filter), version
fields (`supersedes` / `supersededBy` / `isLatest`), temporal validity
(`event_time` / `valid_from` / `valid_until`), `episode_id`,
evidence/confidence, trace events in the journal, and a revision table keyed by
artifact; all schema
changes are applied as in-place migrations (E7/E9/E15 upgrade tests exercise an
old database). The store runs in WAL mode with a busy timeout; encode keeps
node + edges + journal in one `BEGIN IMMEDIATE` transaction, and an
`idempotencyKey` makes retries return the existing record instead of writing a
second one (E20). `dream doctor` checks integrity, journal mode, schema,
orphan edges and duplicate keys; `dream backup` checkpoints the WAL before a
cold copy, and `dream restore` replaces a stopped database with an explicit
`--force` (and removes the stale `-wal`/`-shm` sidecars first). `dream compact`
and the dream cycle prune persisted trace events older than the retention
window, keeping audit events intact.

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
3. **Embeddings and tokenization.** The offline hashing embedder is shallow;
   with a real embedding provider, thresholds (0.45 association, 0.55
   clustering, 0.78 skill match, 0.92 merge, 0.4 lexical fusion weight) must be
   re-tuned via the eval suites. CJK support depends on `Intl.Segmenter` (Node
   20+ full ICU) with a character fallback; BM25 scans all nodes per query, so
   above ~10⁴ nodes it needs an inverted index or FTS5.
4. **Single-writer, no job queue.** `userId` partitions, WAL and per-encode
   transactions are enforced, but the kernel is still a single-process,
   single-writer design. P10-lite adds idempotency and atomic writes; it does
   not add durable write jobs, leases, multi-worker FIFO or crash-resume
   queues. Those are only needed when a second writer/runtime actually exists.
   `runInTransaction` is a process-level guard (concurrent plugin encodes join
   the active transaction), and journal atomicity assumes the journal is the
   same store instance.
5. **External validity.** Most experiments are deterministic synthetic
   corpora. E12 adds seeds/ablations, E18 is a simulated multi-repo stream and
   E21 runs real Node/Python test subprocesses in temporary repositories; the
   live embedding checks are opt-in. A production deployment should still run
   its own real-trajectory benchmark.
6. **Revision extraction is shape-based.** `path/old/new` writes and unified
   patches are recognized; a tool with a different edit protocol needs a small
   deterministic adapter. That is deliberate — asking an LLM to reconstruct a
   diff would defeat the point.
7. **Observability storage.** The live tracer is a bounded in-memory buffer;
   persisted trace events live in the journal and grow until rotated. A
   production deployment should add retention/compaction.
8. **Confidence is a ranking prior, not a calibrated probability.** Temporal
   recall requires an explicit `asOf`; parsing natural-language time
   ("last week") belongs in the query-rewrite plugin.
9. **Tagging and episodes are heuristic.** Tags come from capitalisation,
   identifiers and quotes, so unquoted CJK names may be missed; the 30-minute
   episode gap is a fixed default, not learned from the user's rhythm. Both
   are configurable and can be replaced by a plugin without changing recall.
10. **Typed relations are cue-based.** "because" is causal, but irony and
    negation are not understood. The graph is a high-precision, low-recall
    prior, not a semantic parser; an LLM relation extractor belongs in an
    optional deep-mode plugin, with this graph as the fallback.
