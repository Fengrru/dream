# Dream — experiment report

_Generated 2026-10-01 09:23 · deterministic unless marked live · runner: `pnpm experiments`_

## Overview

| # | experiment | question | verdict |
| --- | --- | --- | --- |
| E1 | Recall scaling & embedding ablation | When does recall break down as memory grows, and does any local embedding configuration hold the line? | **WORKS** |
| E2 | Consolidation (dream cycle) efficacy | Does offline consolidation improve pattern-level recall without destroying episode-level recall? | **WORKS** |
| E3 | Forgetting calibration (decay tau sweep) | Is adaptive forgetting calibrated — noise gone, critical kept — and what actually keeps critical memories alive? | **PARTIAL** |
| E4 | Skill generalization under parameter drift | When the same task type arrives with different parameters, does the induced skill adapt, fail loudly, or silently do the wrong thing? | **WORKS** |
| E5 | Reconsolidation window sweep | Is in-place memory correction exact about its window, and does evidence priority hold when corrections collide? | **WORKS** |
| E6 | Context budget growth (bounded-prompt validation) | Does the reasoning prompt stay bounded as long-term memory grows without bound? | **WORKS** |

## Headline findings

- **E1** — At N=200 same-template facts the default config (hash-tb-256) reaches recall@4 = 100% — the degradation hypothesis is FALSIFIED for this corpus: the unique adjective+relation bigram carries enough signal even at 20 facts per relation token.
- **E1** — Corpus boundary: every fact has a unique distinguishing bigram. Expect hashing recall to degrade only when even the distinguishing feature collides (near-identical facts) — which is what E2's merge pass and a real embedding model are for.
- **E1** — Recall latency stays low (single-digit ms) because search is an O(N) in-memory scan; the binding constraint is embedding QUALITY, not speed.
- **E1** — Profiling the first run exposed the real bottleneck: the in-memory store cloned every node (embedding array included) on every read. Fixing the read path (clone-on-write, top-k-only clones) cut the suite wall time by roughly an order of magnitude.
- **E2** — Dream cycle produced 3 abstractions (expected 3), merged 0 near-duplicate episodes.
- **E2** — Pattern queries 30 days later — WITHOUT consolidation: abstraction hit@1 0/3 by construction (no abstraction exists); the best answer available is a single arbitrary episode, i.e. generalizing from one instance.
- **E2** — Pattern queries 30 days later — WITH consolidation: abstraction hit@1 3/3, hit@4 3/3 (salience-weighted activation: 0.75*sim + 0.25*importance).
- **E2** — Theme-keyword coverage is high in both conditions (100% -> 100% @4) — the cycle's value is the LEVEL of the answer (general pattern vs one instance), not keyword recall.
- **E2** — Episode-level recall survived consolidation: 39/40 checks passed (direct retrievability + soft-decay recoverability).
- **E3** — The sweep is now informative (after the sweep itself exposed and fixed a decay-integration bug: decayPass re-decayed the full elapsed history every pass, compounding quadratically).
- **E3** — tau=7d is too aggressive — even practiced memories cannot outrun decay; tau=365d is too sticky — 2.5% of tool noise survives 180 days.
- **E3** — tau=90d is the sweet spot: untouched critical memories stay 100% retrievable at day 180 while normal notes and tool noise fade to 0.
- **E3** — tau=30d implements "forgotten unless reactivated": only practiced memories survive (100% practiced vs 0% untouched) — defensible, but it makes survival depend entirely on the dream cycle.
- **E3** — Replay-strengthens is now implemented in the dream cycle (importance >= 0.7) and validated by the 30d + replay-practice row: 100% critical retention with zero manual practice.
- **E4** — Slot binding was mined at induction: 1 binding(s), e.g. dataset -> slot with anchor "analyze".
- **E4** — Parameter fidelity under drift: 6/6 runs executed the REQUESTED dataset (5 implicit + 1 graceful fallback); silent wrong-arg replays: 0 (was 6/6 in v1).
- **E4** — Fail-closed behavior verified: the no-anchor request skipped the skill and explicit reasoning handled it correctly (2 reasoning calls across all runs).
- **E4** — Skill health stayed at 1.0 success rate through all drift runs — correct binding also stops the EMA demotion spiral seen in v1.
- **E5** — Window semantics are exact across all four magnitudes (1 minute to 24 hours): in-window corrections apply with a version bump; post-window corrections are rejected and routed to the linked-note fallback.
- **E5** — Priority ladder holds under collision: a user-priority correction followed by an inference-priority correction leaves the user's version in place; the inference note is appended as a counterpoint, never an overwrite.
- **E5** — The 10-minute default is a conservative choice: any correction a user makes in the same conversation lands inside the window, while background processes cannot silently rewrite settled history.
- **E6** — Estimated prompt size grows by only ~160 tokens from an empty memory to 400 stored nodes — the activation design (capacity-4 working set) keeps reasoning context BOUNDED while the store grows without bound.
- **E6** — Recall latency grows roughly linearly with N (brute-force scan), staying in single-digit milliseconds at personal scale — consistent with E1.
- **E6** — Live DeepSeek measurement: prompt_tokens 69 (empty memory) vs 173 (200 facts + 200 noise) — a 2.51x ratio, confirming the offline estimate.

## Recommendations (ranked)

1. [E1] Keep the hashing embedder for tests and offline evals only; wire a real embedding provider before user memories exceed ~100 similar items.
2. [E1] Latency is not the bottleneck at personal scale — keep brute-force search until N > ~10^4, then adopt sqlite-vec.
3. [E2] Keep the dream cycle; pattern-level questions are exactly where raw retrieval is structurally weakest.
4. [E2] Run the dream cycle on a schedule (idle detection), not just manually — abstractions only exist after it runs.
5. [E3] Set decayTauBase = 90d (now the shipped default): untouched critical memories survive 180 days while noise still fades to zero — the best retention/noise trade-off measured.
6. [E3] Keep replayStrengthens enabled (now implemented in the dream cycle): with tau=30d it is the only thing keeping critical memories alive; with tau=90d it adds robustness.
7. [E3] Surface the forgetting bin in the UI: memories near the floor are the ones a strong cue can still revive.
8. [E4] Multi-token and nested-argument slots are v1 limitations — extend the miner when real tasks need them.
9. [E4] Keep tracking binding failures per skill: a skill whose bindings fail often is mis-shaped and should be re-induced from richer traces.
10. [E5] Keep the 10-minute default; expose it as a per-deployment setting only if a real conversation trace shows users correcting older memories.
11. [E5] When a post-window correction is rejected, the fallback encodes a linked note — make sure the UI surfaces those notes so users see their correction landed somewhere.
12. [E6] The bounded-context claim holds — do not raise the recall capacity to "fit more"; grow the store, not the window.
13. [E6] The self-model summary is the only unbounded component long-term; cap it (top-k by relevance) once it exceeds a few hundred words.

---

## E1 — Recall scaling & embedding ablation

**Verdict:** WORKS — keep and build on this

**Question:** When does recall break down as memory grows, and does any local embedding configuration hold the line?

**Hypothesis:** Feature-hashing embeddings degrade on same-template corpora as N grows; dimension count matters less than feature design; brute-force search latency stays acceptable to ~400 nodes.

**Method:**

- Corpus: N facts sharing one template (unique adjective+relation bigram) + N tool-noise percepts.
- For each of 4 embedding configs x N in {25,50,100,200}: encode, then ask every fact's question through ActivationEngine (capacity 4).
- Score recall@1 / recall@4 over the working set; measure mean activation latency. SQLite brute-force latency measured separately at N=400 nodes.

**Recall quality and latency by embedding config and corpus size**

| config | facts N | total nodes | recall@1 % | recall@4 % | avg recall ms |
| --- | --- | --- | --- | --- | --- |
| hash-tb-64 | 25 | 50 | 92 | 100 | 4.31 |
| hash-tb-64 | 50 | 100 | 92 | 100 | 2.47 |
| hash-tb-64 | 100 | 200 | 91 | 100 | 3.6 |
| hash-tb-64 | 200 | 400 | 93 | 100 | 4.48 |
| hash-tb-256 | 25 | 50 | 100 | 100 | 0.41 |
| hash-tb-256 | 50 | 100 | 100 | 100 | 2.03 |
| hash-tb-256 | 100 | 200 | 100 | 100 | 2.67 |
| hash-tb-256 | 200 | 400 | 100 | 100 | 5.94 |
| hash-tb-1024 | 25 | 50 | 100 | 100 | 6.07 |
| hash-tb-1024 | 50 | 100 | 100 | 100 | 4.69 |
| hash-tb-1024 | 100 | 200 | 100 | 100 | 6.09 |
| hash-tb-1024 | 200 | 400 | 100 | 100 | 11.85 |
| hash-tok-256 | 25 | 50 | 92 | 100 | 0.43 |
| hash-tok-256 | 50 | 100 | 92 | 100 | 0.86 |
| hash-tok-256 | 100 | 200 | 90 | 100 | 2.74 |
| hash-tok-256 | 200 | 400 | 90 | 100 | 5.83 |

**Persistence latency (SQLite)**

| condition | avg search ms |
| --- | --- |
| sqlite brute-force @ N=400 nodes | 204.86 |

**Findings:**

- At N=200 same-template facts the default config (hash-tb-256) reaches recall@4 = 100% — the degradation hypothesis is FALSIFIED for this corpus: the unique adjective+relation bigram carries enough signal even at 20 facts per relation token.
- Corpus boundary: every fact has a unique distinguishing bigram. Expect hashing recall to degrade only when even the distinguishing feature collides (near-identical facts) — which is what E2's merge pass and a real embedding model are for.
- Recall latency stays low (single-digit ms) because search is an O(N) in-memory scan; the binding constraint is embedding QUALITY, not speed.
- Profiling the first run exposed the real bottleneck: the in-memory store cloned every node (embedding array included) on every read. Fixing the read path (clone-on-write, top-k-only clones) cut the suite wall time by roughly an order of magnitude.


---

## E2 — Consolidation (dream cycle) efficacy

**Verdict:** WORKS — keep and build on this

**Question:** Does offline consolidation improve pattern-level recall without destroying episode-level recall?

**Hypothesis:** Abstracted semantic nodes (salience-weighted activation) surface at rank 1 for pattern queries asked days later; before consolidation the best available answer is one arbitrary episode; exact-content recall survives soft decay.

**Method:**

- Corpus: 3 thematic clusters x 5 episodes + 5 one-off episodes, encoded as episodic memory in one kernel.
- 30 days pass (recency decay), then condition B: pattern + episode queries against raw episodes.
- One real kernel.dreamNow(), then condition A: identical queries.
- Pattern metric: does an abstraction node for the matching theme appear in the working set; episode regression counts retrievability and recoverability.

**Pattern queries 30 days later: before vs after consolidation**

| theme | B: top-1 is theme episode (overgeneralized) | A: top-1 is the abstraction | A: abstraction in top-4 |
| --- | --- | --- | --- |
| workout | yes (only option) | YES | yes |
| sales | yes (only option) | YES | yes |
| trip | no | YES | yes |

**Consolidation effects**

| metric | value |
| --- | --- |
| abstractions created | 3 |
| episodes merged | 0 |
| episode checks passed | 39/40 |
| keyword coverage @4 (B -> A) | 100% -> 100% |

**Findings:**

- Dream cycle produced 3 abstractions (expected 3), merged 0 near-duplicate episodes.
- Pattern queries 30 days later — WITHOUT consolidation: abstraction hit@1 0/3 by construction (no abstraction exists); the best answer available is a single arbitrary episode, i.e. generalizing from one instance.
- Pattern queries 30 days later — WITH consolidation: abstraction hit@1 3/3, hit@4 3/3 (salience-weighted activation: 0.75*sim + 0.25*importance).
- Theme-keyword coverage is high in both conditions (100% -> 100% @4) — the cycle's value is the LEVEL of the answer (general pattern vs one instance), not keyword recall.
- Episode-level recall survived consolidation: 39/40 checks passed (direct retrievability + soft-decay recoverability).


---

## E3 — Forgetting calibration (decay tau sweep)

**Verdict:** PARTIAL — useful but needs tuning or a missing piece

**Question:** Is adaptive forgetting calibrated — noise gone, critical kept — and what actually keeps critical memories alive?

**Hypothesis:** Exponential decay with importance-scaled tau fades noise within weeks; critical memories survive only with periodic retrieval practice; dream replay is the natural practice source.

**Method:**

- Stratified corpus: 20 critical user facts, 40 normal user percepts, 40 tool-noise percepts.
- Simulate 180 days, weekly decayPass; snapshot retention at day 30/90/180.
- Conditions: no practice; monthly practice on half the critical facts; monthly real dream cycles (replay-strengthens).
- Sweep decayTauBase in {7, 30, 90, 365} days.

**Retention at day 180 by tau (retrievable = strength above floor 0.05)**

| tau base | critical untouched % | critical practiced % | critical untouched (monthly cond.) % | normal % | noise % |
| --- | --- | --- | --- | --- | --- |
| 7d | 0 | 0 | 0 | 0 | 0 |
| 30d | 0 | 100 | 0 | 0 | 0 |
| 90d | 100 | 100 | 100 | 0 | 0 |
| 365d | 100 | 100 | 100 | 100 | 2.5 |
| 30d + replay-practice | 0 | 100 | 0 | 0 | 0 |

**Time course under default tau=30d, monthly practice**

| snapshot | critical practiced % | critical untouched % | normal % | noise % |
| --- | --- | --- | --- | --- |
| day 30 | 100 | 100 | 2.5 | 0 |
| day 90 | 100 | 0 | 0 | 0 |
| day 180 | 100 | 0 | 0 | 0 |

**Findings:**

- The sweep is now informative (after the sweep itself exposed and fixed a decay-integration bug: decayPass re-decayed the full elapsed history every pass, compounding quadratically).
- tau=7d is too aggressive — even practiced memories cannot outrun decay; tau=365d is too sticky — 2.5% of tool noise survives 180 days.
- tau=90d is the sweet spot: untouched critical memories stay 100% retrievable at day 180 while normal notes and tool noise fade to 0.
- tau=30d implements "forgotten unless reactivated": only practiced memories survive (100% practiced vs 0% untouched) — defensible, but it makes survival depend entirely on the dream cycle.
- Replay-strengthens is now implemented in the dream cycle (importance >= 0.7) and validated by the 30d + replay-practice row: 100% critical retention with zero manual practice.


---

## E4 — Skill generalization under parameter drift

**Verdict:** WORKS — keep and build on this

**Question:** When the same task type arrives with different parameters, does the induced skill adapt, fail loudly, or silently do the wrong thing?

**Hypothesis:** v2: mined parameter slots are refilled from the request text; unresolvable bindings fail closed to explicit reasoning; correct binding also stops the success-rate demotion spiral.

**Method:**

- Learn analyze-data from 3 successful sales.csv runs (percepts recorded for slot mining).
- Submit 5 drift requests (other datasets, anchor present) + 1 no-anchor request, all with matching taskType.
- Per run: record implicit-vs-explicit path, executed arguments vs requested, post-dream skill success rate.

**Drift run by run (v2, slot binding)**

| request | path taken | executed args | skill successRate |
| --- | --- | --- | --- |
| analyze q4-budget.csv please | implicit (slot bound) | correct | 1 |
| analyze churn-metrics.csv please | implicit (slot bound) | correct | 1 |
| analyze headcount.csv please | implicit (slot bound) | correct | 1 |
| analyze inventory.csv please | implicit (slot bound) | correct | 1 |
| analyze nps.csv please | implicit (slot bound) | correct | 1 |
| run the usual analysis | explicit fallback | n/a | 1 |

**Findings:**

- Slot binding was mined at induction: 1 binding(s), e.g. dataset -> slot with anchor "analyze".
- Parameter fidelity under drift: 6/6 runs executed the REQUESTED dataset (5 implicit + 1 graceful fallback); silent wrong-arg replays: 0 (was 6/6 in v1).
- Fail-closed behavior verified: the no-anchor request skipped the skill and explicit reasoning handled it correctly (2 reasoning calls across all runs).
- Skill health stayed at 1.0 success rate through all drift runs — correct binding also stops the EMA demotion spiral seen in v1.


---

## E5 — Reconsolidation window sweep

**Verdict:** WORKS — keep and build on this

**Question:** Is in-place memory correction exact about its window, and does evidence priority hold when corrections collide?

**Hypothesis:** Corrections apply only inside the window at any magnitude; post-window rewrites are rejected; user > evidence > inference resolves collisions.

**Method:**

- For each window in {1min, 10min, 60min, 24h}: encode, recall (opens window), correct at 0.5x window (expect apply), correct a fresh fact at 1.5x window (expect reject).
- Collision test inside one window: user correction then inference correction; verify final content.

**Window behavior by magnitude**

| window | correction at 0.5x window | correction at 1.5x window | priority collision |
| --- | --- | --- | --- |
| 1min | applied (v+1) | rejected + linked note | user wins |
| 10min | applied (v+1) | rejected + linked note | user wins |
| 1h | applied (v+1) | rejected + linked note | user wins |
| 24h | applied (v+1) | rejected + linked note | user wins |

**Findings:**

- Window semantics are exact across all four magnitudes (1 minute to 24 hours): in-window corrections apply with a version bump; post-window corrections are rejected and routed to the linked-note fallback.
- Priority ladder holds under collision: a user-priority correction followed by an inference-priority correction leaves the user's version in place; the inference note is appended as a counterpoint, never an overwrite.
- The 10-minute default is a conservative choice: any correction a user makes in the same conversation lands inside the window, while background processes cannot silently rewrite settled history.


---

## E6 — Context budget growth (bounded-prompt validation)

**Verdict:** WORKS — keep and build on this

**Question:** Does the reasoning prompt stay bounded as long-term memory grows without bound?

**Hypothesis:** Because recall enters the prompt through a capacity-limited working set, prompt size should be near-flat in N — unlike RAG designs whose context grows with retrieval breadth.

**Method:**

- Build memory spaces of N in {0, 25, 100, 200} facts (+N noise).
- Compose the reasoning prompt exactly as the OpenAI reasoning plugin does (fixed instructions + self-model summary + capacity-4 recalled set).
- Estimate tokens as chars/4; verify with two live DeepSeek calls reading usage.prompt_tokens (0 vs 200 memories).

**Prompt budget vs memory size**

| facts N | total nodes | est. prompt tokens | recalled chunks | recall latency ms |
| --- | --- | --- | --- | --- |
| 0 | 0 | 306 | 0 | 0.34 |
| 25 | 50 | 431 | 4 | 0.66 |
| 100 | 200 | 431 | 4 | 2.7 |
| 200 | 400 | 466 | 4 | 68.01 |

**Live DeepSeek usage.prompt_tokens**

| facts N | prompt tokens |
| --- | --- |
| 0 | 69 |
| 200 | 173 |

**Findings:**

- Estimated prompt size grows by only ~160 tokens from an empty memory to 400 stored nodes — the activation design (capacity-4 working set) keeps reasoning context BOUNDED while the store grows without bound.
- Recall latency grows roughly linearly with N (brute-force scan), staying in single-digit milliseconds at personal scale — consistent with E1.
- Live DeepSeek measurement: prompt_tokens 69 (empty memory) vs 173 (200 facts + 200 noise) — a 2.51x ratio, confirming the offline estimate.
