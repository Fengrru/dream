**English** | [中文](README.zh-CN.md)

# Dream

**A memory-centric agent.** Dream's kernel is a human-inspired memory system —
a unified memory space with a full lifecycle (encode → consolidate → retrieve
→ reconsolidate → forget). Everything else — the reasoning model, tools, voice,
UI — is a swappable plugin.

> Everything is a plugin, **except memory**. Memory defines who the agent is.

![Dream — the orb is the working-memory gauge, with the memory timeline and live transcript](docs/assets/screenshot.png)

## The problem with every other agent

Every mainstream agent restarts life at every session: one conversation, one
memory, a fresh persona each time. Prompt, vector store, window — and when the
window closes, everything the agent learned is either gone or a dead row in a
retrieval index. It never gets faster at your recurring tasks, never revises a
belief, never forgets anything on purpose.

Dream inverts the architecture. The reasoning loop is not the core; **memory
is**. The model is rented and replaceable; memory is what makes Dream the same
entity across sessions, days, and model upgrades.

## What that buys you

| | Typical agent | Dream |
| --- | --- | --- |
| **Memory** | per-session context + retrieval | one unified space; a session is an activation pattern, not a container |
| **Learning** | fine-tuning or prompt edits | the memory lifecycle *is* the learning loop |
| **Skills** | static instruction files, read every time | procedural memory: induced from repeated work, parameter-slotted, replayed **with zero LLM calls** |
| **Corrections** | stale beliefs persist | recall opens a reconsolidation window; in-window corrections rewrite in place, later ones create a new latest version (old version kept in history) |
| **Forgetting** | everything kept forever | calibrated adaptive decay (τ=90d measured); the forgetting bin can still revive a fading memory |
| **Idle time** | nothing happens | Dream *dreams*: consolidation replays episodes, abstracts patterns, merges duplicates, induces skills, re-strengthens what matters |
| **Safety** | model self-discipline | one pipeline for every tool call (incl. MCP), deny-by-default plugin capabilities, fail-closed approvals, secret scrubbing on write *and* read, tombstone audit |
| **Debuggability** | black box | one trace id per operation; stage events for every retrieval channel; content-free traces; `dream inspect` |
| **Retrieval orchestration** | one similarity score | vector + BM25 + entity tags + episode support, reserved slots and optional RRF fusion |
| **Graph** | untyped nearest-neighbour links | rule-based typed edges, explainable relation paths, optional type priors |

## Evidence, not vibes

Most agent projects ship demos. Dream ships an **experiment suite** — nineteen
controlled, deterministic experiments (`pnpm experiments` → `EXPERIMENTS.md`)
that have already found and fixed real bugs:

| # | experiment | headline result |
| --- | --- | --- |
| E1 | recall scaling × embedding ablation | 100% recall@4 at 400 same-template nodes; the "embeddings degrade" hypothesis was **falsified**; profiling exposed a 10× store bottleneck |
| E2 | consolidation (dream) efficacy | pattern queries 30 days later: abstraction ranked #1 in **3/3** themes (was 0/3 — the experiment drove centroid embeddings, a retrievability gate, and stemming) |
| E3 | forgetting calibration | τ sweep found a **quadratic-compounding decay bug**; calibration set the default τ=90d; replay-strengthens implemented from the data |
| E4 | skill parameter drift | frozen-arg replay silently used the **wrong dataset 6/6** times; slot mining + fail-closed binding brought that to **0/6** |
| E5 | reconsolidation windows | exact from 1 min to 24 h; priority ladder holds under collision |
| E6 | context budget growth | 400 stored memories add only ~160 prompt tokens — bounded context, verified against live API `usage.prompt_tokens` |
| E7 | version chains for late corrections | rejected post-window corrections left the stale fact #1 two months later; superseding versions made the correction #1, retired the stale record, and kept a 4-generation history |
| E8 | hybrid retrieval × working-set diversity | identifier collisions: recall@1 **9% → 100%**; keyword-stuffed logs: **0/20 → 20/20** top-1; distinct facts in the 4-slot working set **2 → 3.3** at ~1.8× recall cost |
| E9 | CJK tokenization | legacy ASCII tokenizer: Chinese recall@4 **0%** (zero vectors); CJK segmentation + character bigrams: **100%**, English unchanged |
| E10 | experience layer | boundary check stopped **1/1** wrong-environment skill replays; mined search keys matched a paraphrased request the label missed; verbatim details returned with the summary |
| E11 | artifact revision chain | two successful edits attached as exact versions 1,2; a rejected edit never entered the chain; zero LLM calls |
| E12 | seeds, ablations, held-out | 5 seeds: **59.7% → 100%** mean recall@1; lexical and diversity gains are independent; held-out corpus shows no regression |
| E13 | owner, scene, intentions, rewrite | foreign slots **66.7% → 0**; scene top-1 **5/10 → 10/10**; intentions expire but stay recallable; synonymous query returns the right fact |
| E14 | stage-level observability | one trace id spans encode/recall; every channel emits stage events; **no content** in traces; events persist for `dream inspect` |
| E15 | event-time validity & evidence | as-of recall excludes stale/future versions; 5 reinforcements raise evidenceCount 1→6 and confidence 0.20→0.82, flipping rank |
| E16 | TriLink layers | fact → experience, fact → revision, revision → fact and experience → fact all traverse; expansion capped at 5 per layer |
| E17 | channel orchestration | tag-only query **0 → 1 result**; 31-min gap splits episodes; episode anchoring raises same-discussion share **2/4 → 3/4**; quotas admit procedural + episodic into a semantic-dominated set |
| E18 | interleaved task resumption (CMB-lite) | summary-only memory: **0/3** diagnostics and a stale timeout resumes fail; full fact+experience+revision stack: **3/3** and resumes successfully |
| E19 | typed graph memory | rule cues create causal/contrast/temporal/elaborates/entity edges; relation paths include the causal hop; type priors move causal/similar activation ratio **1.00 → 1.80** |

The suite runs offline with no API keys; the optional live embedding sweep in E12 is skipped when no key is present.

## Try it

```bash
git clone <this repo> && cd dream
pnpm install

pnpm test          # 121 unit tests
pnpm eval          # 4 functional eval suites (offline, deterministic)
pnpm experiments   # the nineteen experiments → EXPERIMENTS.md

# 1) Offline chat demo — no API key, full memory loop with scripted replies
pnpm demo
#   you › My name is Ada and I live in Seattle
#   you › What is my name?
#   dream › I remember: My name is Ada and I live in Seattle
#   /dream  → run a consolidation cycle and print the dream report

# 2) The real thing: live web app + DeepSeek reasoning + persistent memory
pnpm cli serve --db memory.db --idle-dream 300   # gateway on ws://127.0.0.1:7333
pnpm --filter @dream/web dev                        # → http://localhost:5180
pnpm cli inspect --trace <traceId> --db memory.db  # stage-level trace / --metrics / --json
```

In the web app: switch **Signal source → Dream live**, say things like *"my
flight is QF27 and I prefer aisle seats"*, ask them back in new sessions, open
**Timeline** to watch memories encode with strength/importance, leave it idle
for five minutes and watch it dream. Talk to it with the **Mic** button
(browser speech, zero setup), or have it talk back with **Voice**.

Configuration via `.env` (see [`.env.example`](.env.example)):

```bash
DREAM_API_KEY=sk-...                  # any OpenAI-compatible chat provider
DREAM_BASE_URL=https://api.deepseek.com/v1
DREAM_MODEL=deepseek-chat
DREAM_EMBED_MODEL=text-embedding-3-small   # optional real embeddings
DREAM_MCP_CONFIG=mcp-servers.json          # optional MCP servers (stdio)
```

## How it works

```plaintext
┌──────────────────────────────────────────────────────────────┐
│  orb-ui interface  —  orb = working-memory gauge;            │
│  memory timeline · forgetting bin · dream report · voice     │
└──────────────────────────┬───────────────────────────────────┘
                           │  WebSocket (cognitive state stream)
┌──────────────────────────▼───────────────────────────────────┐
│  plugins (single pipeline, deny-by-default capabilities)     │
│  perception · reasoning (DeepSeek et al.) · tools (MCP)      │
│  voice · policies · dream passes                             │
└──────────────────────────┬───────────────────────────────────┘
                           │  the only exchange medium:
┌──────────────────────────▼───────────────────────────────────┐
│  DREAMCORE — the privileged memory kernel                    │
│  working memory (4±1 chunks = the cognitive bus)             │
│  unified LTM: episodic · semantic · procedural · self        │
│  lifecycle engine = learning engine                          │
│  append-only journal (tombstone audit)                       │
└──────────────────────────────────────────────────────────────┘
```

The full design — activation math, consolidation passes, skill binding,
safety invariants — is in [ARCHITECTURE.md](ARCHITECTURE.md) and
[SAFETY.md](SAFETY.md).

## Packages

| package | role |
| --- | --- |
| `@dream/core` | memory kernel: node model, stores, working-memory bus, spreading activation, encoding gate, lifecycle engine, skill binding, self-model |
| `@dream/kernel` | orchestration: plugin host, capability enforcement, single pipeline, executive session runner |
| `@dream/policies` | deny-by-default presets, fail-closed approvals, secret scrubbing, injection quarantine |
| `@dream/store-sqlite` | libSQL persistence — local-first: one file you own |
| `@dream/plugin-reasoning-openai` | OpenAI-compatible reasoning strategy |
| `@dream/plugin-mcp` | stdio MCP bridge — MCP tools through the same pipeline |
| `@dream/plugin-scripted` | deterministic reasoning + mock tools (tests, evals, demo) |
| `@dream/eval` | the measuring stick: eval suites + the experiment harness |
| `@dream/web` | orb-ui interface, memory panels, voice v1 |
| `@dream/cli` | `dream chat / serve / dream / stats / eval / experiments` |

## Status & roadmap

v0.1.0 — working skeleton through the P0–P9 memory roadmap. Verified: 121
unit tests, 4/4 eval suites, experiments 18×WORKS + 1×PARTIAL, typecheck clean,
live browser sessions with DeepSeek.

- ✅ Multi-user `userId` partitions, versioned corrections, temporal validity,
  typed graph edges, CMB-lite resumption
- 🔜 Durable write-job queue / managed runtime (multi-host productization)
- 🔜 Streaming voice adapters (Pipecat / OpenAI Realtime via orb-ui adapters)
- 🔜 `sqlite-vec` index beyond ~10⁴ nodes; LLM-based abstraction & importance passes
- 🔜 Plugin SDK & manifest format aligned with the dsh ecosystem

Known limits are documented honestly in [ARCHITECTURE.md §8](ARCHITECTURE.md)
(parametric-vs-external memory conflict, credit assignment v1, embedding
thresholds calibrated for the local embedder).

## Development

```bash
pnpm typecheck     # strict TS across the workspace
pnpm test          # vitest
pnpm eval          # functional suites
pnpm experiments   # research report → EXPERIMENTS.md
```

Zero-dependency kernel (`@dream/core` uses node builtins only), internal
packages pattern (sources exported directly; add a bundling step before npm
publish). See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).
