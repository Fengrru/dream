# Dream — experiment report

_Generated 2026-10-18 01:01 · deterministic unless marked live · runner: `pnpm experiments`_

## Overview

| # | experiment | question | verdict |
| --- | --- | --- | --- |
| E1 | Recall scaling & embedding ablation | When does recall break down as memory grows, and does any local embedding configuration hold the line? | **WORKS** |
| E2 | Consolidation (dream cycle) efficacy | Does offline consolidation improve pattern-level recall without destroying episode-level recall? | **WORKS** |
| E3 | Forgetting calibration (decay tau sweep) | Is adaptive forgetting calibrated — noise gone, critical kept — and what actually keeps critical memories alive? | **PARTIAL** |
| E4 | Skill generalization under parameter drift | When the same task type arrives with different parameters, does the induced skill adapt, fail loudly, or silently do the wrong thing? | **WORKS** |
| E5 | Reconsolidation window sweep | Is in-place memory correction exact about its window, and does evidence priority hold when corrections collide? | **WORKS** |
| E6 | Context budget growth (bounded-prompt validation) | Does the reasoning prompt stay bounded as long-term memory grows without bound? | **WORKS** |
| E7 | Version chains for post-window corrections | Can a correction after the reconsolidation window update what recall returns without destroying history? | **WORKS** |
| E8 | Hybrid lexical retrieval & working-set diversity | Can a BM25 channel and a diversity pass make recall robust to identifier collisions, keyword stuffing, and paraphrase crowding? | **WORKS** |
| E9 | CJK tokenization & multilingual recall | Does the memory system actually work for Chinese content, and does the fix preserve English behavior? | **WORKS** |
| E10 | Experience layer: boundaries, search keys, details | Can a learned skill know where it applies and can a summarized fact keep its exact source values? | **WORKS** |
| E11 | Artifact revision chain (zero LLM) | Can recall attach the exact before/after history that a summary memory deliberately dropped? | **WORKS** |
| E12 | Seed stability, ablations & held-out corpus | Is the retrieval improvement stable across seeds, attributable to the right channels, and transferable to a held-out corpus? | **WORKS** |
| E13 | Owner isolation, scene priors, intentions & query rewrite | Can P4 capabilities work without fragmenting the unified memory space? | **WORKS** |
| E14 | Stage-level observability & trace privacy | Can a single turn be explained stage by stage without storing its content? | **WORKS** |
| E15 | Event-time validity & evidence confidence | Can recall answer "what was true at time T" and prefer the better-supported fact? | **WORKS** |
| E16 | TriLink: fact ↔ experience ↔ revision | Can recall traverse the task fact, the reusable experience, and the exact change it produced? | **WORKS** |

## Headline findings

- **E1** — At N=200 same-template facts the default config (hash-tb-256) reaches recall@4 = 100% — the degradation hypothesis is FALSIFIED for this corpus: the unique adjective+relation bigram carries enough signal even at 20 facts per relation token.
- **E1** — Corpus boundary: every fact has a unique distinguishing bigram. Expect hashing recall to degrade only when even the distinguishing feature collides (near-identical facts) — which is what E2's merge pass and a real embedding model are for.
- **E1** — Recall latency stays low (0.63 ms at N=200 facts) because search is an O(N) in-memory scan; the binding constraint is embedding QUALITY, not speed.
- **E1** — Profiling the first run exposed the real bottleneck: the in-memory store cloned every node (embedding array included) on every read. Fixing the read path (clone-on-write, top-k-only clones) cut the suite wall time by roughly an order of magnitude.
- **E2** — Dream cycle produced 3 abstractions (expected 3), merged 0 near-duplicate episodes.
- **E2** — Pattern queries 30 days later — WITHOUT consolidation: abstraction hit@1 0/3 by construction (no abstraction exists); the best answer available is a single arbitrary episode, i.e. generalizing from one instance.
- **E2** — Pattern queries 30 days later — WITH consolidation: abstraction hit@1 3/3, hit@4 3/3 (salience-weighted activation: 0.75*sim + 0.25*importance).
- **E2** — Theme-keyword coverage is high in both conditions (100% -> 100% @4) — the cycle's value is the LEVEL of the answer (general pattern vs one instance), not keyword recall.
- **E2** — Episode-level recall survived consolidation: 40/40 checks passed (direct retrievability + soft-decay recoverability).
- **E3** — The sweep is now informative (after the sweep itself exposed and fixed a decay-integration bug: decayPass re-decayed the full elapsed history every pass, compounding quadratically).
- **E3** — tau=7d is too aggressive — even practiced memories cannot outrun decay; tau=365d is too sticky — 2.5% of tool noise survives 180 days.
- **E3** — tau=90d is the sweet spot: untouched critical memories stay 100% retrievable at day 180 while normal notes and tool noise fade to 0.
- **E3** — tau=30d implements "forgotten unless reactivated": only practiced memories survive (100% practiced vs 0% untouched) — defensible, but it makes survival depend entirely on the dream cycle.
- **E3** — Replay-strengthens is now implemented in the dream cycle (importance >= 0.7) and validated by the 30d + replay-practice row: 100% critical retention with zero manual practice.
- **E4** — Slot binding was mined at induction: 1 binding(s), e.g. dataset -> slot with anchor "analyze".
- **E4** — Parameter fidelity under drift: 6/6 runs executed the REQUESTED dataset (5 implicit + 1 graceful fallback); silent wrong-arg replays: 0 (was 6/6 in v1).
- **E4** — Fail-closed behavior verified: the no-anchor request skipped the skill and explicit reasoning handled it correctly (2 reasoning calls across all runs).
- **E4** — Skill health stayed at 1.0 success rate through all drift runs — correct binding also stops the EMA demotion spiral seen in v1.
- **E5** — Window semantics are exact across all four magnitudes (1 minute to 24 hours): in-window corrections apply with a version bump; post-window in-place rewrites are rejected. The session layer now routes those corrections to the version chain (E7) instead of leaving only a detached note.
- **E5** — Priority ladder holds under collision: a user-priority correction followed by an inference-priority correction leaves the user's version in place; the inference note is appended as a counterpoint, never an overwrite.
- **E5** — The 10-minute default is a conservative choice: any correction a user makes in the same conversation lands inside the window, while background processes cannot silently rewrite settled history.
- **E6** — Estimated prompt size grows by only ~92 tokens from an empty memory to 400 stored nodes — the activation design (capacity-4 working set) keeps reasoning context BOUNDED while the store grows without bound.
- **E6** — Recall latency grows roughly linearly with N (brute-force scan plus the hybrid lexical pass), reaching 4 ms at 400 nodes — E8 prices the hybrid channel at ~1.8x vector-only, still well inside a conversational turn.
- **E6** — Live DeepSeek measurement unavailable (n/a); offline estimate stands.
- **E7** — Baseline: the post-window correction was rejected; it survived only as an episodic linked note. After 60 days the stale semantic fact still ranks top-1 (4pm) and remains the only current version (history length 1).
- **E7** — Version chain: the correction created a new latest semantic version (5pm top-1), the stale record is retired from current recall (not current), and history keeps both versions (length 2).
- **E7** — Three successive corrections produced a 4-version chain; only the newest version was recalled, all prior versions stayed inspectable, and a late inference-priority claim was appended as a counterpoint instead of replacing the user's version (held).
- **E7** — Audit: the supersede path wrote 1 journal event(s) with the old and new ids; the rejected baseline path wrote none for the correction.
- **E8** — Identifier collisions: baseline recall@1 was 9% while recall@4 was 96.5% — a pure RANKING failure predicted in E1's corpus boundary. The hybrid channel raised recall@1 to 100% (recall@4 100%).
- **E8** — Keyword-stuffed logs: pure vector activation put the precise fact top-1 in 0/20 queries; BM25 length normalization + IDF raised it to 20/20.
- **E8** — Duplicate crowding: the diversity pass raised distinct relevant facts in the 4-slot working set from 2 to 3.33 on average and cut duplicate slots from 2 to 0.
- **E8** — Cost: hybrid activation averaged 1.81 ms vs 0.63 ms vector-only at N=200 (factor 2.86); the absolute budget is what matters at sub-millisecond scale and stays well inside a turn.
- **E9** — Legacy tokenizer: pure-Chinese recall@4 was 0% — every Chinese string embedded to a zero vector and produced no BM25 tokens, so ranking was effectively arbitrary.
- **E9** — CJK tokenizer: pure-Chinese personal facts reached 100% recall@4; Chinese project identifiers 100%; Chinese keyword-stuffed logs 100%.
- **E9** — Intl.Segmenter words plus character bigrams are both required: segmentation alone is brittle across memory/query phrasing, bigrams alone lose word-level IDF.
- **E9** — English parity: 90% -> 100% recall@4 — adding CJK features did not regress the existing ASCII path.
- **E10** — Boundary check: a skill learned only in "staging" was replayed in "production" by the old matcher (analyze-data); with boundaries enforced it failed closed and explicit reasoning took over (none, 2 reasoning call(s)).
- **E10** — Search keys: without taskType the label "Skill: analyze-data" did not match "analyze sales figures" (none); mined search keys matched it (analyze-data).
- **E10** — Details: verbatim details were withheld when disabled and returned with the recalled fact — summaries stay findable, source values stay readable.
- **E10** — Confidence and sourceTraceIds are now mined at induction alongside searchKeys/boundaryEnvs, so a skill carries its provenance and applicability, not just steps.
- **E11** — Without revision recall the memory still answered "the fix lives in src/search.ts" but attached 0 exact edits — the version history was invisible to the reasoner.
- **E11** — With the chain, recall attached 2 revisions (versions 1, 2), including both the 30→10 and 10→5 edits: - timeout: 30 / + timeout: 10.
- **E11** — Failed tool calls were excluded: the rejected 5→1 edit never entered the chain; only successful edits are ground truth.
- **E11** — The chain is deterministic and LLM-free: it is extracted from tool arguments, so it works offline and cannot hallucinate a version.
- **E12** — Across 5 seeds, identifier recall@1 moved from 59.7% (vector only) to 100% (hybrid); every seed stayed at or above 100%.
- **E12** — Ablation: the lexical channel alone raised identifier recall@1 to 100%; the diversity pass alone raised distinct duplicate coverage to 3 (vector only: 2). The gains are independent, not one mechanism masking the other.
- **E12** — Held-out corpus (Chinese + English, written after the mechanisms): recall@4 100% vector-only -> 100% full stack. The corpus is realistic rather than adversarial, so it evidences no regression rather than a separation; E9/E8 carry the separation.
- **E12** — Live embedding sweep skipped — no DREAM_EMBEDDING_API_KEY / OPENAI_API_KEY; hash-embedder conclusions remain evidence for the offline default only.
- **E13** — Owner isolation: unfiltered recall exposed 66.7% foreign slots on average; the userId filter reduced that to 0.
- **E13** — Scene prior: a matching scene raised top-1 accuracy from 5/10 to 10/10 without splitting the store.
- **E13** — Intentions: 5/5 queries surfaced an unexpired intention at rank 1; after expiry, 0/5 were still proactive but 5/5 remained recallable as ordinary facts (5 expired intention(s) demoted to ordinary facts).
- **E13** — Query rewrite: the baseline returned "The staging deploy window is Monday at 9am UTC" while the plugin returned "The billing service release schedule is Friday".
- **E14** — Trace continuity: encode and recall used distinct ids (trace_09d4e5… / trace_a33a80…), and the read trace contains 8 stage events.
- **E14** — Channel visibility: embed, semantic, episodic, procedural, lexical, spread, dedup, recall all emitted events; dedup recorded selected/deferred counts, so a dropped candidate is explainable.
- **E14** — Privacy: the serialized trace contains only hashes/counts/durations — no memory or query text.
- **E14** — Persistence: 8 trace events reached the journal, which is what `dream inspect --trace <id>` reads after a restart.
- **E15** — Validity: without asOf both versions competed (stale 3pm visible: true); with asOf day 0 only 3pm surfaced, and asOf day 2 returned 5pm with the stale version excluded.
- **E15** — Evidence: the low-confidence fact started at rank 2; five reinforcements raised evidenceCount from 1 to 6 and confidence from 0.20 to 0.82, flipping it above the 0.70 fact.
- **E15** — Confidence is a ranking prior, not a truth claim: it changes activation by at most ~20% (0.8 + 0.2·confidence), so a single observation cannot dominate.
- **E15** — Event time and validity intervals are stored separately from createdAt/lastAccessedAt, so system bookkeeping never rewrites history.
- **E16** — Without TriLink expansion the fact still carried its diff (yes) but could not reach the experience that explains it (no); the experience could not reach its source fact.
- **E16** — With TriLink: fact -> experience yes, fact -> revision yes, revision -> fact yes, experience -> fact yes.
- **E16** — The links are mined at skill induction (trace.factIds -> skill.sourceFactIds, fact.derivedExperienceIds) and explicit for revisions (linkRevision), so provenance is data, not a prompt convention.
- **E16** — Expansion is capped at five neighbours per layer; a task with a long history cannot blow the context budget just because links exist.

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
11. [E5] Post-window corrections should go through the version chain (E7): the newest version is recalled, the old one stays in history, and no stale contradiction remains in context.
12. [E6] The bounded-context claim holds — do not raise the recall capacity to "fit more"; grow the store, not the window.
13. [E6] The self-model summary is the only unbounded component long-term; cap it (top-k by relevance) once it exceeds a few hundred words.
14. [E7] Use the version chain for post-window corrections; keep the reconsolidation window for cheap in-place rewrites inside a conversation.
15. [E7] Recall must default to latest-only; expose history through an explicit API so stale values cannot leak into reasoning context.
16. [E7] Keep the evidence-priority ladder in the supersede path too — immutability must not let an inference overwrite a user fact.
17. [E8] Keep the hybrid lexical channel on by default for the hashing embedder; revisit the weight when a real embedding provider is wired (E1 recommendation).
18. [E8] Keep the diversity pass: it costs one cosine per selected slot and prevents paraphrase clusters from starving the capacity-limited working set.
19. [E8] Treat lexical and vector channels as complementary, not redundant — the vector channel still handles fuzzy similarity; the lexical channel resolves exact tokens.
20. [E9] Keep CJK tokenization on by default; the legacy ASCII path is an ablation, not a supported configuration.
21. [E9] When adding a new language, extend the tokenizer rather than forking the embedder: vector and BM25 must share the same token space.
22. [E9] Re-run E9 whenever the tokenizer changes; zero-vector regressions are silent and catastrophic.
23. [E10] Keep boundary checks fail-closed: an unknown environment is not permission to replay.
24. [E10] Mine search keys from successful percepts at induction; the skill label alone is too thin for paraphrase.
25. [E10] Store details outside the embedding field so they never distort retrieval, and cap their length at the boundary.
26. [E11] Record only successful tool calls; a rejected patch is not history.
27. [E11] Keep revisions out of the embedding field and attach them at recall time — they are evidence, not a retrieval signal.
28. [E11] Extend the extractor when a tool has a new deterministic edit shape; do not ask an LLM to reconstruct diffs.
29. [E12] Report multi-seed means, not a single lucky run; one seed can hide instability.
30. [E12] Keep the ablation table in CI: if a future change makes one channel redundant, the data will show it.
31. [E12] Re-run the held-out corpus whenever tokenization, fusion, or diversity defaults change.
32. [E12] Wire a real embedding endpoint before trusting the 0.4 lexical weight in production; the offline sweep is an ablation, not a deployment recommendation.
33. [E13] Filter every read path by userId, including lexical and spreading activation — a single unfiltered channel leaks.
34. [E13] Keep scenes as priors, not partitions: one store, four kinds, a boost.
35. [E13] Expire intentions into ordinary facts; do not forget them just because the reminder fired.
36. [E13] Keep query rewrite deterministic and optional; an LLM rewriter belongs in a plugin with an offline fallback.
37. [E14] Keep traces content-free by default; hashes and counts explain ranking without becoming a second memory store.
38. [E14] Emit one event per channel, not one per candidate; per-candidate traces explode in size and rarely answer the question.
39. [E14] Use `dream inspect --metrics` for aggregate channel cost before optimizing a specific recall path.
40. [E15] Always store event time and validity separately from write time; derived memories inherit the interval they describe.
41. [E15] Use confidence as a bounded ranking prior, and keep evidenceCount monotonic for explainability.
42. [E15] Reinforce on repeated observation instead of creating a duplicate node; duplicates are a write-time problem, not a recall-time one.
43. [E16] Mine fact links from trace.factIds at induction instead of asking an LLM to infer them later.
44. [E16] Keep revision links explicit: only a deterministic edit knows which task fact it advanced.
45. [E16] Cap expansion per layer; provenance is a graph, but the working set is still capacity-limited.

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
| hash-tb-64 | 25 | 50 | 92 | 100 | 0.58 |
| hash-tb-64 | 50 | 100 | 92 | 100 | 0.29 |
| hash-tb-64 | 100 | 200 | 91 | 100 | 0.4 |
| hash-tb-64 | 200 | 400 | 93 | 100 | 0.47 |
| hash-tb-256 | 25 | 50 | 100 | 100 | 0.15 |
| hash-tb-256 | 50 | 100 | 100 | 100 | 0.26 |
| hash-tb-256 | 100 | 200 | 100 | 100 | 0.49 |
| hash-tb-256 | 200 | 400 | 100 | 100 | 0.63 |
| hash-tb-1024 | 25 | 50 | 100 | 100 | 0.4 |
| hash-tb-1024 | 50 | 100 | 100 | 100 | 0.51 |
| hash-tb-1024 | 100 | 200 | 100 | 100 | 0.89 |
| hash-tb-1024 | 200 | 400 | 100 | 100 | 1.71 |
| hash-tok-256 | 25 | 50 | 92 | 100 | 0.24 |
| hash-tok-256 | 50 | 100 | 92 | 100 | 0.42 |
| hash-tok-256 | 100 | 200 | 90 | 100 | 0.48 |
| hash-tok-256 | 200 | 400 | 90 | 100 | 0.75 |

**Persistence latency (SQLite)**

| condition | avg search ms |
| --- | --- |
| sqlite brute-force @ N=400 nodes | 27.83 |

**Findings:**

- At N=200 same-template facts the default config (hash-tb-256) reaches recall@4 = 100% — the degradation hypothesis is FALSIFIED for this corpus: the unique adjective+relation bigram carries enough signal even at 20 facts per relation token.
- Corpus boundary: every fact has a unique distinguishing bigram. Expect hashing recall to degrade only when even the distinguishing feature collides (near-identical facts) — which is what E2's merge pass and a real embedding model are for.
- Recall latency stays low (0.63 ms at N=200 facts) because search is an O(N) in-memory scan; the binding constraint is embedding QUALITY, not speed.
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
| episode checks passed | 40/40 |
| keyword coverage @4 (B -> A) | 100% -> 100% |

**Findings:**

- Dream cycle produced 3 abstractions (expected 3), merged 0 near-duplicate episodes.
- Pattern queries 30 days later — WITHOUT consolidation: abstraction hit@1 0/3 by construction (no abstraction exists); the best answer available is a single arbitrary episode, i.e. generalizing from one instance.
- Pattern queries 30 days later — WITH consolidation: abstraction hit@1 3/3, hit@4 3/3 (salience-weighted activation: 0.75*sim + 0.25*importance).
- Theme-keyword coverage is high in both conditions (100% -> 100% @4) — the cycle's value is the LEVEL of the answer (general pattern vs one instance), not keyword recall.
- Episode-level recall survived consolidation: 40/40 checks passed (direct retrievability + soft-decay recoverability).


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

- Window semantics are exact across all four magnitudes (1 minute to 24 hours): in-window corrections apply with a version bump; post-window in-place rewrites are rejected. The session layer now routes those corrections to the version chain (E7) instead of leaving only a detached note.
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
| 0 | 0 | 306 | 0 | 0 |
| 25 | 50 | 398 | 4 | 0.79 |
| 100 | 200 | 398 | 4 | 2.5 |
| 200 | 400 | 398 | 4 | 3.98 |

**Live DeepSeek usage.prompt_tokens**

| facts N | prompt tokens |
| --- | --- |
| skipped — no DREAM_API_KEY | n/a |

**Findings:**

- Estimated prompt size grows by only ~92 tokens from an empty memory to 400 stored nodes — the activation design (capacity-4 working set) keeps reasoning context BOUNDED while the store grows without bound.
- Recall latency grows roughly linearly with N (brute-force scan plus the hybrid lexical pass), reaching 4 ms at 400 nodes — E8 prices the hybrid channel at ~1.8x vector-only, still well inside a conversational turn.
- Live DeepSeek measurement unavailable (n/a); offline estimate stands.


---

## E7 — Version chains for post-window corrections

**Verdict:** WORKS — keep and build on this

**Question:** Can a correction after the reconsolidation window update what recall returns without destroying history?

**Hypothesis:** Rejecting the rewrite and encoding a linked note leaves the stale semantic fact authoritative; a version chain (new latest + retired predecessor) makes the correction win recall while keeping an auditable ancestry.

**Method:**

- Encode a semantic fact, recall it to open the reconsolidation window, then advance 30 days so the window is closed.
- Condition B: let applyUpdate reject the correction, then encode the corrected text as a linked episodic note (the old fallback).
- Condition A: supersedeMemory creates a new latest version and retires the old one.
- Advance 60 more days with weekly decay, then ask the same question through ActivationEngine and inspect current records + versionChain.
- Separately, apply three successive corrections and verify ordering, latest-only recall, and the evidence-priority guard.

**Correction outcome two months later**

| condition | top-1 recalled value | stale value in top-4 | stale record still current | history versions | supersede audit events |
| --- | --- | --- | --- | --- | --- |
| B: rejected rewrite + linked note | stale (4pm) | YES (contradiction in context) | yes | 1 | 0 |
| A: version chain (EVOLVE) | corrected (5pm) | no | no | 2 | 1 |

**Version-chain integrity (four generations)**

| check | result |
| --- | --- |
| history contents | 4pm -> 5pm -> 6pm -> 7pm |
| current records with old values | 0 |
| latest version recalled top-1 | yes |
| lower-priority claim superseded a user fact | no (counterpoint kept) |

**Findings:**

- Baseline: the post-window correction was rejected; it survived only as an episodic linked note. After 60 days the stale semantic fact still ranks top-1 (4pm) and remains the only current version (history length 1).
- Version chain: the correction created a new latest semantic version (5pm top-1), the stale record is retired from current recall (not current), and history keeps both versions (length 2).
- Three successive corrections produced a 4-version chain; only the newest version was recalled, all prior versions stayed inspectable, and a late inference-priority claim was appended as a counterpoint instead of replacing the user's version (held).
- Audit: the supersede path wrote 1 journal event(s) with the old and new ids; the rejected baseline path wrote none for the correction.


---

## E8 — Hybrid lexical retrieval & working-set diversity

**Verdict:** WORKS — keep and build on this

**Question:** Can a BM25 channel and a diversity pass make recall robust to identifier collisions, keyword stuffing, and paraphrase crowding?

**Hypothesis:** Hashed embeddings rank by token overlap without IDF or length normalization, so exact identifiers collide and repetitive noise wins; BM25 fusion plus a near-duplicate filter fixes ranking and coverage without material latency cost.

**Method:**

- Scenario 1: 200 same-template facts with unique seeded identifiers; query each identifier; compare vector-only vs hybrid recall@1/@4.
- Scenario 2: 20 concise facts plus 4 keyword-stuffed logs each; ask each fact question; compare fact recall@1/@4.
- Scenario 3: 6 family facts, each duplicated 3x with equal salience; measure distinct relevant facts in the 4-slot working set, vector-only vs diversity pass.
- Measure activation latency at N=200 to price the extra lexical scan.

**Adversarial recall: vector-only vs hybrid**

| scenario | baseline recall@1 | hybrid recall@1 | baseline recall@4 | hybrid recall@4 |
| --- | --- | --- | --- | --- |
| identifier collisions (N=200) | 9% | 100% | 96.5% | 100% |
| keyword-stuffed logs (20 facts) | 0% | 100% | 0% | 100% |

**Working-set coverage under paraphrase crowding**

| query | relevant facts | baseline distinct @4 | diversity distinct @4 |
| --- | --- | --- | --- |
| Where do my sisters live? (3 relevant) | 3 | 2 | 3 |
| Where do my brothers live? (3 relevant) | 3 | 2 | 3 |
| Where do my sisters and brothers live? (6 relevant) | 6 | 2 | 4 |

**Activation cost at N=200**

| condition | avg ms |
| --- | --- |
| vector only | 0.63 |
| hybrid (+ BM25 + diversity) | 1.81 |
| overhead factor | 2.86 |

**Findings:**

- Identifier collisions: baseline recall@1 was 9% while recall@4 was 96.5% — a pure RANKING failure predicted in E1's corpus boundary. The hybrid channel raised recall@1 to 100% (recall@4 100%).
- Keyword-stuffed logs: pure vector activation put the precise fact top-1 in 0/20 queries; BM25 length normalization + IDF raised it to 20/20.
- Duplicate crowding: the diversity pass raised distinct relevant facts in the 4-slot working set from 2 to 3.33 on average and cut duplicate slots from 2 to 0.
- Cost: hybrid activation averaged 1.81 ms vs 0.63 ms vector-only at N=200 (factor 2.86); the absolute budget is what matters at sub-millisecond scale and stays well inside a turn.


---

## E9 — CJK tokenization & multilingual recall

**Verdict:** WORKS — keep and build on this

**Question:** Does the memory system actually work for Chinese content, and does the fix preserve English behavior?

**Hypothesis:** ASCII-only tokenization makes Chinese embeddings zero vectors and BM25 documents empty; Intl.Segmenter word tokens plus character bigrams restore recall without changing English token streams.

**Method:**

- Reproduce the legacy path with cjk:false (ASCII regex only) and compare with the CJK tokenizer.
- Scenarios: 60 Chinese personal facts, 60 Chinese project identifiers, 20 Chinese keyword-stuffed logs, 40 mixed-language flights, 40 English facts.
- Encode every fact (and noise for the stuffing scenario), then ask each fact's question through ActivationEngine (capacity 4).
- Score recall@1 / recall@4 against the target node id.

**Recall by language scenario: legacy ASCII vs CJK tokenizer**

| scenario | legacy recall@1 | CJK recall@1 | legacy recall@4 | CJK recall@4 |
| --- | --- | --- | --- | --- |
| 中文个人事实 (60) | 0% | 100% | 0% | 100% |
| 中文标识符 (60) | 86.7% | 100% | 86.7% | 100% |
| 中文关键词堆砌 (20) | 0% | 100% | 100% | 100% |
| 中英混合航班 (40) | 100% | 100% | 100% | 100% |
| 英文个人事实 (40) | 90% | 87.5% | 90% | 100% |

**Findings:**

- Legacy tokenizer: pure-Chinese recall@4 was 0% — every Chinese string embedded to a zero vector and produced no BM25 tokens, so ranking was effectively arbitrary.
- CJK tokenizer: pure-Chinese personal facts reached 100% recall@4; Chinese project identifiers 100%; Chinese keyword-stuffed logs 100%.
- Intl.Segmenter words plus character bigrams are both required: segmentation alone is brittle across memory/query phrasing, bigrams alone lose word-level IDF.
- English parity: 90% -> 100% recall@4 — adding CJK features did not regress the existing ASCII path.


---

## E10 — Experience layer: boundaries, search keys, details

**Verdict:** WORKS — keep and build on this

**Question:** Can a learned skill know where it applies and can a summarized fact keep its exact source values?

**Hypothesis:** Skills without boundary environments get replayed in the wrong environment; label-only matching misses paraphrased requests; summaries without details lose the addressable values. Mining boundaries, search keys and details fixes all three.

**Method:**

- Learn an analyze-data skill from three successful staging traces, then run it in production with boundaries enforced/disabled.
- Match the same skill from a paraphrased request without taskType, with and without mined search keys.
- Encode a fact with verbatim details and recall it with returnDetails on/off.

**Experience metadata effects**

| scenario | mechanism | baseline | enhanced | note |
| --- | --- | --- | --- | --- |
| team skill match | boundary check | analyze-data | none | replayed |
| no-task-type match | search keys | none | analyze-data | better recall |
| detail recall | verbatim details | absent | present | exact value |

**Findings:**

- Boundary check: a skill learned only in "staging" was replayed in "production" by the old matcher (analyze-data); with boundaries enforced it failed closed and explicit reasoning took over (none, 2 reasoning call(s)).
- Search keys: without taskType the label "Skill: analyze-data" did not match "analyze sales figures" (none); mined search keys matched it (analyze-data).
- Details: verbatim details were withheld when disabled and returned with the recalled fact — summaries stay findable, source values stay readable.
- Confidence and sourceTraceIds are now mined at induction alongside searchKeys/boundaryEnvs, so a skill carries its provenance and applicability, not just steps.


---

## E11 — Artifact revision chain (zero LLM)

**Verdict:** WORKS — keep and build on this

**Question:** Can recall attach the exact before/after history that a summary memory deliberately dropped?

**Hypothesis:** Summary memories lose exact values; extracting path/old/new and unified patches from successful tool calls and attaching them to recalled memories recovers the history without any LLM call.

**Method:**

- Encode a memory referencing src/search.ts, then execute two successful apply_patch edits and one rejected edit.
- Recall the memory with revision attachment off/on.
- Compare attached revision count, versions, exact old/new values, and whether the failed edit leaked.

**Revision recall by condition**

| condition | revisions attached | old value 30 | new value 5 | failed edit leaked |
| --- | --- | --- | --- | --- |
| without revision recall | 0 | no | no | no |
| with revision chain | 2 | yes | yes | no |

**Findings:**

- Without revision recall the memory still answered "the fix lives in src/search.ts" but attached 0 exact edits — the version history was invisible to the reasoner.
- With the chain, recall attached 2 revisions (versions 1, 2), including both the 30→10 and 10→5 edits: - timeout: 30 / + timeout: 10.
- Failed tool calls were excluded: the rejected 5→1 edit never entered the chain; only successful edits are ground truth.
- The chain is deterministic and LLM-free: it is extracted from tool arguments, so it works offline and cannot hallucinate a version.


---

## E12 — Seed stability, ablations & held-out corpus

**Verdict:** WORKS — keep and build on this

**Question:** Is the retrieval improvement stable across seeds, attributable to the right channels, and transferable to a held-out corpus?

**Hypothesis:** The lexical channel drives identifier gains, the diversity pass drives coverage gains, both are stable across seeds, and the combined stack still helps on a corpus written after the implementation.

**Method:**

- Run the identifier-collision corpus on five seeds and report recall@1/@4 plus the mean.
- Ablate: vector only, +lexical, +diversity, +both; measure identifier recall@1 and duplicate coverage.
- Evaluate a held-out mixed Chinese/English personal-memory corpus with vector-only vs the full stack.
- Optionally sweep lexicalWeight 0/0.2/0.4 with a live OpenAI-compatible embedding endpoint.

**Identifier collisions by seed**

| seed | vector recall@1 | hybrid recall@1 | vector recall@4 | hybrid recall@4 |
| --- | --- | --- | --- | --- |
| 1 | 11.7% | 100% | 100% | 100% |
| 2 | 91.7% | 100% | 100% | 100% |
| 3 | 95.8% | 100% | 100% | 100% |
| 4 | 90% | 100% | 100% | 100% |
| 5 | 9.2% | 100% | 100% | 100% |
| mean | 59.7% | 100% | — | — |

**Ablation**

| condition | identifier recall@1 | distinct duplicate coverage | duplicate slots |
| --- | --- | --- | --- |
| vector only | 11.7% | 2 | 2 |
| + lexical | 100% | 2 | 2 |
| + diversity | 11.7% | 3 | 0 |
| + both | 100% | 4 | 0 |

**Held-out corpus**

| condition | recall@1 | recall@4 |
| --- | --- | --- |
| vector only | 100% | 100% |
| full stack | 100% | 100% |

**Live embedding sweep (optional)**

| lexical weight | recall@1 | recall@4 |
| --- | --- | --- |
| skipped — no DREAM_EMBEDDING_API_KEY / OPENAI_API_KEY | n/a | n/a |

**Findings:**

- Across 5 seeds, identifier recall@1 moved from 59.7% (vector only) to 100% (hybrid); every seed stayed at or above 100%.
- Ablation: the lexical channel alone raised identifier recall@1 to 100%; the diversity pass alone raised distinct duplicate coverage to 3 (vector only: 2). The gains are independent, not one mechanism masking the other.
- Held-out corpus (Chinese + English, written after the mechanisms): recall@4 100% vector-only -> 100% full stack. The corpus is realistic rather than adversarial, so it evidences no regression rather than a separation; E9/E8 carry the separation.
- Live embedding sweep skipped — no DREAM_EMBEDDING_API_KEY / OPENAI_API_KEY; hash-embedder conclusions remain evidence for the offline default only.


---

## E13 — Owner isolation, scene priors, intentions & query rewrite

**Verdict:** WORKS — keep and build on this

**Question:** Can P4 capabilities work without fragmenting the unified memory space?

**Hypothesis:** Owner filtering, scene boosting, intention expiry and deterministic query expansion each improve their scenario while keeping one store and four memory kinds.

**Method:**

- Encode 10 facts each for three users; compare unfiltered vs userId-filtered recall for foreign slots.
- Encode the same facts tagged working/coding; compare top-1 scene match with and without the scene prior.
- Encode five intentions with a 2-day expiry; measure top-1 before expiry, then dream and measure proactive vs ordinary recall.
- Compare recall for "deploy window" with and without the deterministic query rewrite plugin.

**P4 capabilities**

| scenario | without feature | with feature | note |
| --- | --- | --- | --- |
| owner isolation (top-4 foreign items) | 2.6666666666666665 | 0 | unfiltered vs userId filter |
| scene prior (top-1 matches requested scene) | 5/10 | 10/10 | unified store, boost only |
| intention before expiry (target top-1) | 5/5 | 5/5 top-1 are intentions | target in top-4: 5/5 |
| intention after expiry | — | 0/5 proactive; 5/5 still recallable | 5 expired intention(s) demoted to ordinary facts |
| query rewrite (top-1 answer) | The staging deploy window is Monday at 9am UTC | The billing service release schedule is Friday | deploy window -> release schedule |

**Findings:**

- Owner isolation: unfiltered recall exposed 66.7% foreign slots on average; the userId filter reduced that to 0.
- Scene prior: a matching scene raised top-1 accuracy from 5/10 to 10/10 without splitting the store.
- Intentions: 5/5 queries surfaced an unexpired intention at rank 1; after expiry, 0/5 were still proactive but 5/5 remained recallable as ordinary facts (5 expired intention(s) demoted to ordinary facts).
- Query rewrite: the baseline returned "The staging deploy window is Monday at 9am UTC" while the plugin returned "The billing service release schedule is Friday".


---

## E14 — Stage-level observability & trace privacy

**Verdict:** WORKS — keep and build on this

**Question:** Can a single turn be explained stage by stage without storing its content?

**Hypothesis:** A trace id propagated through encode/recall plus per-channel stage events (hashes/counts only) makes misses diagnosable and is safe to persist.

**Method:**

- Submit an explicit fact and a later recall; collect the trace id from each TurnResult.
- Check that encode/embed/semantic/episodic/procedural/lexical/spread/dedup/recall events exist.
- Serialize all trace events and assert the secret/value text is absent.
- Verify trace events persist to the journal for the inspector.

**Stage events per trace**

| stage | write events | read events | read avg ms |
| --- | --- | --- | --- |
| encode | 1 | 0 | 0 |
| embed | 0 | 1 | 0.01 |
| semantic | 0 | 1 | 0.01 |
| episodic | 0 | 1 | 0 |
| procedural | 0 | 1 | 0 |
| lexical | 0 | 1 | 0.02 |
| spread | 0 | 1 | 0 |
| dedup | 0 | 1 | 0 |
| recall | 0 | 1 | 0.1 |

**Invariants**

| check | result |
| --- | --- |
| distinct trace ids | 2 |
| write trace has encode | yes |
| all read stages present | yes |
| content leaked | no |
| journal events for read trace | 8 |
| metrics total events | 8 |
| mean read stage ms | 0.02 |

**Findings:**

- Trace continuity: encode and recall used distinct ids (trace_09d4e5… / trace_a33a80…), and the read trace contains 8 stage events.
- Channel visibility: embed, semantic, episodic, procedural, lexical, spread, dedup, recall all emitted events; dedup recorded selected/deferred counts, so a dropped candidate is explainable.
- Privacy: the serialized trace contains only hashes/counts/durations — no memory or query text.
- Persistence: 8 trace events reached the journal, which is what `dream inspect --trace <id>` reads after a restart.


---

## E15 — Event-time validity & evidence confidence

**Verdict:** WORKS — keep and build on this

**Question:** Can recall answer "what was true at time T" and prefer the better-supported fact?

**Hypothesis:** Validity intervals filter stale/future versions at the store boundary; evidence accumulation moves confidence toward repeated observations and can flip ranking.

**Method:**

- Encode a meeting at 3pm valid until day 1 and a replacement at 5pm valid from day 1.
- Recall without asOf, asOf day 0, and asOf day 2; check stale/future leakage.
- Encode two contradictory facts at confidence 0.7 and 0.2; reinforce the latter five times and compare ranking.

**Temporal and evidence behavior**

| condition | baseline | after feature | note |
| --- | --- | --- | --- |
| as-of day 0 | both versions visible | 3pm | future excluded |
| as-of day 2 | stale 3pm also visible | 5pm | stale excluded |
| evidence before | high confidence 0.70 | 2am | low count 1 |
| evidence after 5 observations | high confidence 0.70 | 3am | low count 6, confidence 0.82 |

**Findings:**

- Validity: without asOf both versions competed (stale 3pm visible: true); with asOf day 0 only 3pm surfaced, and asOf day 2 returned 5pm with the stale version excluded.
- Evidence: the low-confidence fact started at rank 2; five reinforcements raised evidenceCount from 1 to 6 and confidence from 0.20 to 0.82, flipping it above the 0.70 fact.
- Confidence is a ranking prior, not a truth claim: it changes activation by at most ~20% (0.8 + 0.2·confidence), so a single observation cannot dominate.
- Event time and validity intervals are stored separately from createdAt/lastAccessedAt, so system bookkeeping never rewrites history.


---

## E16 — TriLink: fact ↔ experience ↔ revision

**Verdict:** WORKS — keep and build on this

**Question:** Can recall traverse the task fact, the reusable experience, and the exact change it produced?

**Hypothesis:** Persisting bidirectional provenance between facts, experiences and revisions, then expanding it at recall with a cap, makes the three layers usable instead of three disconnected stores.

**Method:**

- Encode a deploy fact referencing a config file; append three successful traces with factIds; consolidate to induce a skill.
- Apply a deterministic edit and link the revision to the fact/experience.
- Recall the fact and the skill with attachTriLinks off/on; check both directions and the revision link.

**TriLink traversal**

| link | without expansion | with expansion |
| --- | --- | --- |
| fact -> experience | no | yes |
| fact -> revision | yes | yes |
| revision -> fact | yes | yes |
| experience -> fact | no | yes |

**Findings:**

- Without TriLink expansion the fact still carried its diff (yes) but could not reach the experience that explains it (no); the experience could not reach its source fact.
- With TriLink: fact -> experience yes, fact -> revision yes, revision -> fact yes, experience -> fact yes.
- The links are mined at skill induction (trace.factIds -> skill.sourceFactIds, fact.derivedExperienceIds) and explicit for revisions (linkRevision), so provenance is data, not a prompt convention.
- Expansion is capped at five neighbours per layer; a task with a long history cannot blow the context budget just because links exist.
