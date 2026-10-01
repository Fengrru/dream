# Contributing to Dream

Thanks for being interested. A few notes that will save everyone time.

## The ground rules

1. **Evidence over vibes.** Dream ships an experiment suite for a reason:
   memory mechanisms are easy to believe in and easy to get wrong. If you
   change activation, decay, consolidation, or skill induction, run
   `pnpm experiments` and include the before/after numbers in your PR.
2. **Fail closed.** Anything touching memory writes, tools, or approvals must
   deny on ambiguity. No silent fallbacks that execute with stale state.
3. **One door.** All tool calls go through `kernel.executeTool`; all memory
   access goes through the capability-checked facade. PRs that add a side
   channel (including for MCP or voice) will be asked to route through the
   pipeline instead.
4. **Deterministic tests.** No network in `pnpm test`. Use the scripted
   plugins, `FakeClock`-style fakes, and the hashing embedder. Live API
   checks belong in the experiment suite behind env-var gates.

## Getting set up

```bash
pnpm install
pnpm typecheck    # strict TS, noUncheckedIndexedAccess
pnpm test         # vitest, 70 tests
pnpm eval         # functional suites
pnpm experiments  # six experiments → EXPERIMENTS.md (~2 min)
```

## Where things live

| you want to change… | go to |
| --- | --- |
| activation, decay, consolidation, skill mining | `packages/core/src/` |
| plugin host, pipelines, session executive | `packages/kernel/src/` |
| approvals, presets, scrubbing, injection | `packages/policies/src/` |
| persistence | `packages/store-sqlite/src/` |
| a new tool source (MCP-style) | `packages/plugins/` — copy `mcp/` |
| the web UI | `apps/web/src/` |
| the `dream` command | `apps/dream-cli/src/` |
| experiments | `packages/eval/src/experiments/` |

## Adding an experiment

Experiments are the project's credibility. A new one should:

- state **question / hypothesis / method / findings**, in that order;
- be deterministic (seeded corpus, fake clock) unless it explicitly measures
  live cost — then gate on `DREAM_API_KEY`;
- report a **verdict** (`works` / `partial` / `fails`) and honest
  recommendations, including negative results. E4 shipped as a FAIL and that
  is exactly why it got fixed.

## Safety review

Changes to the memory pipeline or policies should reference the invariant
numbers in [SAFETY.md](SAFETY.md) (I1–I6) they preserve. If you add a new
threat surface, add it to the threat-model table with its defense — or write
the honest limitation.

## Style

- TypeScript strict, ESM, no default exports in packages.
- Comments explain **why**, and only when the code can't. Experiment
  references (`experiment E3`) are encouraged — they are the receipts.
- Keep the kernel dependency-free (`@dream/core` uses node builtins only).

## Commit / PR

Small, focused changes. Run `pnpm typecheck && pnpm test` before pushing; CI
runs those plus `pnpm eval`, the web build, and the experiment suite.

## License

Contributions are accepted under the MIT license (see [LICENSE](LICENSE)).
